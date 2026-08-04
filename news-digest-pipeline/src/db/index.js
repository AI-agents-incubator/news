import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

// The fetchers treat fewer than 100 characters as not-yet-extracted content.
// Keep the queue on the same boundary so URL-only/placeholder rows cannot spend
// an LLM call before the fetcher has produced a usable article body.
export const MIN_READY_ARTICLE_CONTENT_CHARS = 100;

export function initDb(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Idempotent migrations for existing DBs
  const articleCols = new Set(db.prepare('PRAGMA table_info(articles)').all().map((c) => c.name));
  if (!articleCols.has('source_chat_id')) {
    db.exec('ALTER TABLE articles ADD COLUMN source_chat_id TEXT');
  }
  if (!articleCols.has('source_message_id')) {
    db.exec('ALTER TABLE articles ADD COLUMN source_message_id TEXT');
  }
  if (!articleCols.has('fetch_attempts')) {
    db.exec('ALTER TABLE articles ADD COLUMN fetch_attempts INTEGER DEFAULT 0');
  }
  if (!articleCols.has('processing_lease_id')) {
    db.exec('ALTER TABLE articles ADD COLUMN processing_lease_id TEXT');
  }
  if (!articleCols.has('processing_lease_expires_at')) {
    db.exec('ALTER TABLE articles ADD COLUMN processing_lease_expires_at INTEGER');
  }

  // Token accounting + cost columns on digests (idempotent)
  const digestCols = new Set(db.prepare('PRAGMA table_info(digests)').all().map((c) => c.name));
  if (!digestCols.has('seq_number')) {
    // createDigest writes seq_number, so older DBs missing this column break
    // digest creation entirely. Add it and backfill existing rows in order.
    db.exec('ALTER TABLE digests ADD COLUMN seq_number INTEGER');
    const rows = db.prepare('SELECT id FROM digests ORDER BY created_at ASC, rowid ASC').all();
    const setSeq = db.prepare('UPDATE digests SET seq_number = ? WHERE id = ?');
    rows.forEach((r, i) => setSeq.run(i + 1, r.id));
  }
  if (!digestCols.has('model')) {
    db.exec('ALTER TABLE digests ADD COLUMN model TEXT');
  }
  if (!digestCols.has('input_tokens')) {
    db.exec('ALTER TABLE digests ADD COLUMN input_tokens INTEGER DEFAULT 0');
  }
  if (!digestCols.has('output_tokens')) {
    db.exec('ALTER TABLE digests ADD COLUMN output_tokens INTEGER DEFAULT 0');
  }
  if (!digestCols.has('cost_usd')) {
    db.exec('ALTER TABLE digests ADD COLUMN cost_usd REAL');
  }

  // `digest_stage_artifacts` is created by schema.sql on fresh databases. Its
  // columns are deliberately checked here as well because live deployments may
  // have received an early schema version before the full card ledger landed.
  const digestArtifactCols = new Set(
    db.prepare('PRAGMA table_info(digest_stage_artifacts)').all().map((c) => c.name)
  );
  const digestArtifactAdditions = [
    ['source_entries_json', 'TEXT'],
    ['raw_response', 'TEXT'],
    ['result_json', 'TEXT'],
    ['image_file', 'TEXT'],
    ['image_sha256', 'TEXT'],
    ['image_width', 'INTEGER'],
    ['image_height', 'INTEGER'],
    ['image_bytes', 'INTEGER'],
    ['input_rate_usd_per_million', 'REAL'],
    ['output_rate_usd_per_million', 'REAL'],
    ['pricing_version', 'TEXT'],
    ['accounting_status', "TEXT NOT NULL DEFAULT 'usage_not_reported'"],
    // SQLite does not permit a non-constant expression default in every
    // ALTER TABLE version. Fresh schema gets the timestamp default; an older
    // table receives a nullable column and is backfilled below.
    ['updated_at', 'TEXT'],
  ];
  for (const [name, definition] of digestArtifactAdditions) {
    if (!digestArtifactCols.has(name)) {
      db.exec(`ALTER TABLE digest_stage_artifacts ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(`UPDATE digest_stage_artifacts
    SET updated_at = COALESCE(updated_at, created_at, datetime('now'))
    WHERE updated_at IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_stage_active_fingerprint
    ON digest_stage_artifacts(digest_id, stage, stage_version, source_sha256, prompt_sha256)
    WHERE status IN ('running', 'succeeded')`);

  // The original carousel ledger only permitted top-level `comment` receipts.
  // SQLite cannot widen a CHECK constraint in place, so preserve every legacy
  // row while rebuilding this small receipt table for the threaded v4 contract.
  // No table has a foreign key to these receipt rows.
  const receiptTableSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'digest_instagram_meta_receipts'`
  ).get()?.sql || '';
  if (!receiptTableSql.includes("'comment_reply'")) {
    db.exec(`
      BEGIN;
      ALTER TABLE digest_instagram_meta_receipts RENAME TO digest_instagram_meta_receipts_legacy;
      CREATE TABLE digest_instagram_meta_receipts (
        id TEXT PRIMARY KEY,
        carousel_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('media_publish', 'comment', 'comment_reply')),
        ordinal INTEGER NOT NULL,
        request_sha256 TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('intent', 'accepted', 'unknown', 'reconciled', 'failed', 'ambiguous', 'inconclusive')),
        remote_id TEXT,
        response_json TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(carousel_id, operation, ordinal),
        FOREIGN KEY (carousel_id) REFERENCES digest_instagram_carousels(id) ON DELETE RESTRICT
      );
      INSERT INTO digest_instagram_meta_receipts
        (id, carousel_id, operation, ordinal, request_sha256, request_json, state,
         remote_id, response_json, error, created_at, updated_at)
      SELECT id, carousel_id, operation, ordinal, request_sha256, request_json, state,
             remote_id, response_json, error, created_at, updated_at
      FROM digest_instagram_meta_receipts_legacy;
      DROP TABLE digest_instagram_meta_receipts_legacy;
      CREATE INDEX IF NOT EXISTS idx_digest_instagram_receipt_lookup
        ON digest_instagram_meta_receipts(carousel_id, operation, ordinal);
      COMMIT;
    `);
  }

  // The retry loop stores the exact correction request in input_sha256 while
  // retaining a stable source-input fingerprint for resume/idempotency.
  const artifactCols = new Set(db.prepare('PRAGMA table_info(article_stage_artifacts)').all().map((c) => c.name));
  if (!artifactCols.has('root_input_sha256')) {
    db.exec('ALTER TABLE article_stage_artifacts ADD COLUMN root_input_sha256 TEXT');
    db.exec('UPDATE article_stage_artifacts SET root_input_sha256 = input_sha256 WHERE root_input_sha256 IS NULL');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_article_stage_root_success
    ON article_stage_artifacts(article_id, stage, stage_version, root_input_sha256, prompt_sha256, status)`);

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function insertArticle({ url, title, content, source = 'extension', sourceChatId = null, sourceMessageId = null }) {
  const existing = db.prepare('SELECT id, url, title, status FROM articles WHERE url = ?').get(url);
  if (existing) {
    return { ...existing, duplicate: true };
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO articles (id, url, title, content, source, source_chat_id, source_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, url, title || null, content || null, source, sourceChatId, sourceMessageId);

  return { id, url, title, status: 'new', duplicate: false };
}

export function getNewArticles(limit = 50) {
  return db.prepare(
    'SELECT * FROM articles WHERE status = ? AND digest_id IS NULL ORDER BY created_at ASC LIMIT ?'
  ).all('new', limit);
}

/**
 * New articles that are safe for automatic digest generation.
 *
 * URL-only Telegram/API ingestion intentionally creates a `new` row first so
 * the server fetcher can enrich it. Automatic consumers must select only rows
 * that have crossed the same content threshold used by that fetcher. Explicit
 * operator selection by id remains available through the digest API.
 */
export function getReadyArticles(limit = 50) {
  return db.prepare(
    `SELECT * FROM articles
      WHERE status = ?
        AND digest_id IS NULL
        AND length(trim(COALESCE(content, ''))) >= ?
      ORDER BY created_at ASC
      LIMIT ?`
  ).all('new', MIN_READY_ARTICLE_CONTENT_CHARS, limit);
}

/** Count articles eligible for automatic digest generation. */
export function getReadyArticleCount() {
  return db.prepare(
    `SELECT COUNT(*) as count FROM articles
      WHERE status = ?
        AND digest_id IS NULL
        AND length(trim(COALESCE(content, ''))) >= ?`
  ).get('new', MIN_READY_ARTICLE_CONTENT_CHARS).count;
}

/**
 * Atomically reserve ready articles for automatic/default digest generation.
 *
 * Selecting and changing the rows to `processing` happens in one SQLite
 * transaction. That means a second queue/API/Telegram trigger cannot receive
 * the same rows after this function returns. `threshold` is checked inside the
 * transaction as well, so an under-threshold queue run never strands a partial
 * batch in `processing`.
 *
 * This intentionally does not cover an explicit operator-supplied article id
 * list. That manual path preserves its existing behaviour.
 */
export function claimReadyArticles({ limit = 50, threshold = 1, leaseMs = 30 * 60 * 1000 } = {}) {
  const claimLimit = Math.max(1, Math.floor(Number(limit) || 0));
  const requiredCount = Math.max(1, Math.floor(Number(threshold) || 0));
  const normalizedLeaseMs = Math.max(60_000, Math.floor(Number(leaseMs) || 0));

  const countReady = db.prepare(
    `SELECT COUNT(*) as count FROM articles
      WHERE status = ?
        AND digest_id IS NULL
        AND length(trim(COALESCE(content, ''))) >= ?`
  );
  const selectReady = db.prepare(
    `SELECT * FROM articles
      WHERE status = ?
        AND digest_id IS NULL
        AND length(trim(COALESCE(content, ''))) >= ?
      ORDER BY created_at ASC
      LIMIT ?`
  );
  const markProcessing = db.prepare(
    `UPDATE articles
        SET status = 'processing',
            processing_lease_id = ?,
            processing_lease_expires_at = ?,
            updated_at = datetime('now')
      WHERE id = ?
        AND status = 'new'
        AND digest_id IS NULL
        AND length(trim(COALESCE(content, ''))) >= ?`
  );
  const recoverExpired = db.prepare(
    `UPDATE articles
        SET status = 'new',
            processing_lease_id = NULL,
            processing_lease_expires_at = NULL,
            updated_at = datetime('now')
      WHERE status = 'processing'
        AND digest_id IS NULL
        AND (processing_lease_expires_at IS NULL OR processing_lease_expires_at <= ?)`
  );

  const claim = db.transaction(() => {
    const now = Date.now();
    // Legacy processing rows have no lease timestamp. They are necessarily
    // from a worker that predates this contract, so recover them on first run.
    recoverExpired.run(now);

    const readyCount = countReady.get('new', MIN_READY_ARTICLE_CONTENT_CHARS).count;
    if (readyCount < requiredCount) return [];

    const articles = selectReady.all('new', MIN_READY_ARTICLE_CONTENT_CHARS, claimLimit);
    const leaseId = uuidv4();
    const leaseExpiresAt = now + normalizedLeaseMs;
    for (const article of articles) {
      const result = markProcessing.run(
        leaseId,
        leaseExpiresAt,
        article.id,
        MIN_READY_ARTICLE_CONTENT_CHARS
      );
      // A row changing between the SELECT and UPDATE would otherwise create an
      // ambiguous partial claim. Throwing rolls the whole transaction back.
      if (result.changes !== 1) {
        throw new Error(`Could not claim article ${article.id}`);
      }
    }

    return articles.map((article) => ({
      ...article,
      status: 'processing',
      processing_lease_id: leaseId,
      processing_lease_expires_at: leaseExpiresAt,
    }));
  });

  // Reserve the SQLite write lock before reading the candidate rows. This
  // serializes claims from separate Node processes as well as from this process.
  return claim.immediate();
}

/**
 * Renew a complete automatic-generation lease. A false result means that a
 * recovery worker has already reclaimed part of the batch, so the old worker
 * must stop without writing any more state.
 */
export function renewArticleLease(articleIds, leaseId, leaseMs = 30 * 60 * 1000) {
  if (!leaseId || !Array.isArray(articleIds) || articleIds.length === 0) return false;
  const expiresAt = Date.now() + Math.max(60_000, Math.floor(Number(leaseMs) || 0));
  const now = Date.now();
  const renew = db.prepare(
    `UPDATE articles
        SET processing_lease_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
        AND status = 'processing'
        AND digest_id IS NULL
        AND processing_lease_id = ?
        AND processing_lease_expires_at > ?`
  );
  const stillOwned = db.prepare(
    `SELECT 1 FROM articles
      WHERE id = ?
        AND status = 'processing'
        AND digest_id IS NULL
        AND processing_lease_id = ?
        AND processing_lease_expires_at > ?`
  );
  const tx = db.transaction((ids) => {
    // Verify the whole batch before renewing any row. A partial renewal would
    // make an old worker look alive after it has already lost another article.
    for (const id of ids) {
      if (!stillOwned.get(id, leaseId, now)) return false;
    }
    for (const id of ids) {
      renew.run(expiresAt, id, leaseId, now);
    }
    return true;
  });
  return tx.immediate(articleIds);
}

/** Write generated commentary only while this worker still owns the lease. */
export function updateClaimedArticleCommentary(id, commentary, leaseId) {
  return db.prepare(
    `UPDATE articles
        SET commentary = ?, updated_at = datetime('now')
      WHERE id = ?
        AND status = 'processing'
        AND digest_id IS NULL
        AND processing_lease_id = ?
        AND processing_lease_expires_at > ?`
  ).run(commentary, id, leaseId, Date.now()).changes === 1;
}

/** Mark a claimed article errored only while the current worker owns it. */
export function failClaimedArticle(id, leaseId) {
  return db.prepare(
    `UPDATE articles
        SET status = 'error',
            processing_lease_id = NULL,
            processing_lease_expires_at = NULL,
            updated_at = datetime('now')
      WHERE id = ?
        AND status = 'processing'
        AND digest_id IS NULL
        AND processing_lease_id = ?
        AND processing_lease_expires_at > ?`
  ).run(id, leaseId, Date.now()).changes === 1;
}

export function getArticleCount(status) {
  if (status) {
    return db.prepare('SELECT COUNT(*) as count FROM articles WHERE status = ?').get(status).count;
  }
  return db.prepare('SELECT COUNT(*) as count FROM articles').get().count;
}

export function updateArticleStatus(id, status) {
  db.prepare(
    `UPDATE articles SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, id);
}

/**
 * Record a per-article fetch/extraction failure from the local fetcher.
 *
 * Increments fetch_attempts and, once it reaches maxAttempts, flips the article
 * to the terminal 'unfetchable' status. Since the fetcher only ever re-selects
 * 'new'/'error' articles, 'unfetchable' drops the article out of the loop for
 * good — this is what stops the endless every-5-minutes Chrome re-open storm on
 * URLs that never yield content.
 *
 * IMPORTANT: only genuine PER-ARTICLE failures may reach here (dead URL, empty
 * page while the reader itself works). A SYSTEMIC reader outage (e.g. Chrome's
 * "Allow JavaScript from Apple Events" disabled, which fails every article) must
 * NOT call this — the fetcher aborts the whole run in that case, so a working
 * page that is simply empty is the only thing that caps here.
 */
export function recordFetchFailure(id, maxAttempts = 5, fetchError = null) {
  const row = db.prepare('SELECT status, fetch_attempts FROM articles WHERE id = ?').get(id);
  if (!row) return null;
  const attempts = (row.fetch_attempts || 0) + 1;
  const capped = attempts >= maxAttempts;
  db.prepare(
    `UPDATE articles
        SET fetch_attempts = ?,
            status = CASE WHEN ? THEN 'unfetchable' ELSE status END,
            fetch_error = COALESCE(?, fetch_error),
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(attempts, capped ? 1 : 0, fetchError, id);
  return { id, attempts, capped, status: capped ? 'unfetchable' : row.status };
}

export function updateArticleCommentary(id, commentary) {
  db.prepare(
    `UPDATE articles SET commentary = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(commentary, id);
}

export function assignArticlesToDigest(articleIds, digestId) {
  const stmt = db.prepare(
    `UPDATE articles SET digest_id = ?, status = 'used', updated_at = datetime('now') WHERE id = ?`
  );
  const transaction = db.transaction((ids) => {
    for (const id of ids) {
      stmt.run(digestId, id);
    }
  });
  transaction(articleIds);
}

/**
 * Create a digest and consume its claimed articles in one immediate SQLite
 * transaction. Every article must still hold `leaseId`; otherwise nothing is
 * written, so a stale worker cannot leave an orphan digest or steal work that
 * a recovery worker has already reclaimed.
 */
export function createClaimedDigest({
  date,
  part = 1,
  articlesCount = 0,
  content,
  status = 'draft',
  generationLog,
  model,
  inputTokens = 0,
  outputTokens = 0,
  costUsd = null,
}, articleIds, leaseId) {
  if (!leaseId || !Array.isArray(articleIds) || articleIds.length === 0) {
    throw new Error('createClaimedDigest requires a non-empty article lease');
  }

  const stillOwned = db.prepare(
    `SELECT 1 FROM articles
      WHERE id = ?
        AND status = 'processing'
        AND digest_id IS NULL
        AND processing_lease_id = ?
        AND processing_lease_expires_at > ?`
  );
  const nextSequence = db.prepare('SELECT COALESCE(MAX(seq_number), 0) as max FROM digests');
  const insertDigest = db.prepare(
    `INSERT INTO digests
       (id, date, part, articles_count, seq_number, content, status,
        generation_log, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const consume = db.prepare(
    `UPDATE articles
        SET digest_id = ?,
            status = 'used',
            processing_lease_id = NULL,
            processing_lease_expires_at = NULL,
            updated_at = datetime('now')
      WHERE id = ?
        AND status = 'processing'
        AND digest_id IS NULL
        AND processing_lease_id = ?
        AND processing_lease_expires_at > ?`
  );

  const finalize = db.transaction((ids) => {
    const now = Date.now();
    for (const id of ids) {
      if (!stillOwned.get(id, leaseId, now)) {
        throw new Error('Processing lease lost before digest finalization');
      }
    }

    const id = uuidv4();
    const seq = nextSequence.get().max + 1;
    insertDigest.run(
      id, date, part, articlesCount, seq, content, status,
      generationLog, model, inputTokens, outputTokens, costUsd
    );

    for (const articleId of ids) {
      if (consume.run(id, articleId, leaseId, now).changes !== 1) {
        throw new Error('Processing lease lost during digest finalization');
      }
    }
    return id;
  });

  return finalize.immediate(articleIds);
}

export function createDigest({ date, part = 1, articlesCount = 0 }) {
  const id = uuidv4();
  // Auto-increment seq_number
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq_number), 0) as max FROM digests').get().max;
  db.prepare(
    `INSERT INTO digests (id, date, part, articles_count, seq_number) VALUES (?, ?, ?, ?, ?)`
  ).run(id, date, part, articlesCount, maxSeq + 1);
  return id;
}

export function updateDigest(id, fields) {
  const allowed = ['content', 'status', 'generation_log', 'published_at',
    'facebook_post_id', 'telegram_message_id', 'youtube_post_id', 'articles_count',
    'model', 'input_tokens', 'output_tokens', 'cost_usd'];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return;

  updates.push(`updated_at = datetime('now')`);
  values.push(id);

  db.prepare(`UPDATE digests SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function getDigest(id) {
  return db.prepare(digestWithStageAccountingSql('WHERE d.id = ?')).get(id);
}

export function getDigests(filters = {}) {
  let where = '';
  const params = [];

  if (filters.status) {
    where = 'WHERE d.status = ?';
    params.push(filters.status);
  }

  let query = digestWithStageAccountingSql(where);
  query += ' ORDER BY d.created_at DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return db.prepare(query).all(...params);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Digest review snapshots cannot contain undefined');
  return encoded;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function reviewItemSourceJson({ articleId, position, title, url, content }) {
  return canonicalJson({ articleId, position, title: title ?? null, url, content });
}

function hydrateDigestReviewItem(row) {
  if (!row) return undefined;
  return {
    ...row,
    source_title: row.title,
    source_url: row.url,
    source_content: row.content,
  };
}

function hydrateDigestReviewRun(row) {
  if (!row) return undefined;
  const items = db.prepare(
    'SELECT * FROM digest_review_items WHERE run_id = ? ORDER BY position ASC'
  ).all(row.id).map(hydrateDigestReviewItem);
  const phase1Attempts = db.prepare(
    'SELECT * FROM digest_review_phase1_attempts WHERE run_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(row.id);
  const phase2Attempts = db.prepare(
    'SELECT * FROM digest_review_phase2_attempts WHERE run_id = ? ORDER BY attempt_no ASC'
  ).all(row.id);
  const phase2Items = row.phase2_items_json ? JSON.parse(row.phase2_items_json) : null;
  return {
    ...row,
    settings: JSON.parse(row.settings_json),
    phase2_items: phase2Items,
    phase1_attempts: phase1Attempts,
    phase2_attempts: phase2Attempts,
    items,
    item_count: items.length,
    succeeded_count: items.filter((item) => item.phase1_status === 'succeeded').length,
    failed_count: items.filter((item) => item.phase1_status === 'failed').length,
    included_count: items.filter((item) => item.included === 1).length,
    selected_count: phase2Items
      ? phase2Items.length
      : items.filter((item) => item.included === 1 && item.phase1_status === 'succeeded').length,
    ambiguous_count: items.filter((item) => item.phase1_status === 'ambiguous').length,
    phase2_attempt_count: phase2Attempts.length,
  };
}

/**
 * Create an immutable two-phase review run and snapshot every source item.
 * Queue/manual sources must transfer the complete, still-live lease set into
 * `digest_review`; reruns only copy lineage and never mutate source articles.
 */
export function createDigestReviewRun({
  sourceKind,
  sourceDigestId = null,
  sourceOrderKind = 'claimed_order',
  settings,
  articles,
  leaseId = null,
}) {
  if (!['queue', 'manual', 'rerun'].includes(sourceKind)) {
    throw new Error('Invalid digest review source kind');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Digest review settings must be an object');
  }
  const sourceMaxChars = Number(settings.sourceMaxChars);
  if (!Number.isSafeInteger(sourceMaxChars) || sourceMaxChars < 1) {
    throw new Error('Digest review settings require a positive sourceMaxChars integer');
  }
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error('Digest review run requires at least one article');
  }
  if (new Set(articles.map((article) => article.id)).size !== articles.length) {
    throw new Error('Digest review run contains duplicate article ids');
  }
  if (sourceKind === 'rerun') {
    if (!sourceDigestId || leaseId) throw new Error('Rerun requires a source digest and no lease');
  } else if (sourceKind === 'queue') {
    if (!leaseId || sourceDigestId) throw new Error('Queue review run requires a lease and no source digest');
  } else if (sourceDigestId) {
    throw new Error('Manual review run cannot have a source digest');
  }

  const settingsJson = canonicalJson(settings);
  const runId = uuidv4();
  const create = db.transaction(() => {
    let snapshots;
    if (sourceKind === 'rerun') {
      if (!db.prepare('SELECT 1 FROM digests WHERE id = ?').get(sourceDigestId)) {
        throw new Error('Source digest not found');
      }
      snapshots = articles.map((article) => ({
        id: String(article.id),
        title: article.title ?? null,
        url: String(article.url || ''),
        content: String(article.content || ''),
      }));
    } else if (sourceKind === 'queue' || leaseId) {
      const now = Date.now();
      const claimedRows = db.prepare(
        `SELECT id, title, url, content FROM articles
          WHERE status = 'processing'
            AND digest_id IS NULL
            AND processing_lease_id = ?
            AND processing_lease_expires_at > ?
          ORDER BY created_at ASC, rowid ASC`
      ).all(leaseId, now);
      const requestedIds = new Set(articles.map((article) => article.id));
      if (claimedRows.length !== articles.length
        || claimedRows.some((article) => !requestedIds.has(article.id))) {
        throw new Error('Digest review lease does not match the complete claimed article set');
      }
      const byId = new Map(claimedRows.map((article) => [article.id, article]));
      snapshots = articles.map((article) => byId.get(article.id));
    } else {
      const selectManual = db.prepare(
        `SELECT id, title, url, content FROM articles
          WHERE id = ? AND status = 'new' AND digest_id IS NULL`
      );
      snapshots = articles.map((article) => selectManual.get(article.id));
      if (snapshots.some((article) => !article)) {
        throw new Error('Manual digest review article is unavailable');
      }
    }

    if (snapshots.some((article) => !article.url || !article.content)) {
      throw new Error('Digest review source snapshots require url and content');
    }
    // Preserve the full immutable source. Phase 1 applies sourceMaxChars at
    // call time, while a later rerun may intentionally choose a larger slice.
    snapshots = snapshots.map((article) => ({
      ...article,
      content: String(article.content),
    }));

    db.prepare(
      `INSERT INTO digest_review_runs
         (id, source_kind, source_digest_id, source_order_kind, settings_json,
          settings_sha256, status, lease_id)
       VALUES (?, ?, ?, ?, ?, ?, 'phase1_processing', ?)`
    ).run(
      runId, sourceKind, sourceDigestId, sourceOrderKind, settingsJson,
      sha256(settingsJson), leaseId
    );

    const insertItem = db.prepare(
      `INSERT INTO digest_review_items
         (id, run_id, article_id, position, title, url, content, source_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    snapshots.forEach((article, index) => {
      const position = index + 1;
      const sourceJson = reviewItemSourceJson({
        articleId: article.id,
        position,
        title: article.title,
        url: article.url,
        content: article.content,
      });
      insertItem.run(
        uuidv4(), runId, article.id, position, article.title ?? null,
        article.url, article.content, sha256(sourceJson)
      );
    });

    if (sourceKind === 'queue' || leaseId) {
      const transferred = db.prepare(
        `UPDATE articles
            SET status = 'digest_review', processing_lease_id = NULL,
                processing_lease_expires_at = NULL, updated_at = datetime('now')
          WHERE status = 'processing'
            AND digest_id IS NULL
            AND processing_lease_id = ?
            AND processing_lease_expires_at > ?`
      ).run(leaseId, Date.now());
      if (transferred.changes !== snapshots.length) {
        throw new Error('Processing lease lost during digest review transfer');
      }
    } else if (sourceKind === 'manual') {
      const transferManual = db.prepare(
        `UPDATE articles
            SET status = 'digest_review', updated_at = datetime('now')
          WHERE id = ? AND status = 'new' AND digest_id IS NULL`
      );
      for (const article of snapshots) {
        if (transferManual.run(article.id).changes !== 1) {
          throw new Error(`Manual digest review article ${article.id} changed during transfer`);
        }
      }
    }
    return hydrateDigestReviewRun(db.prepare(
      'SELECT * FROM digest_review_runs WHERE id = ?'
    ).get(runId));
  });
  return create.immediate();
}

export function getDigestReviewRun(id) {
  return hydrateDigestReviewRun(db.prepare(
    'SELECT * FROM digest_review_runs WHERE id = ?'
  ).get(id));
}

export function listDigestReviewRuns(limit = 20) {
  const normalizedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  return db.prepare(
    `SELECT r.id, r.source_kind, r.source_digest_id, r.result_digest_id,
            r.source_order_kind, r.status, r.error, r.phase1_completed_at,
            r.phase2_claimed_at, r.completed_at, r.created_at, r.updated_at,
            COUNT(i.id) AS item_count,
            COALESCE(SUM(CASE WHEN i.phase1_status = 'succeeded' THEN 1 ELSE 0 END), 0)
              AS succeeded_count,
            COALESCE(SUM(CASE WHEN i.phase1_status = 'failed' THEN 1 ELSE 0 END), 0)
              AS failed_count,
            COALESCE(SUM(CASE WHEN i.included = 1 THEN 1 ELSE 0 END), 0)
              AS included_count,
            COALESCE(SUM(CASE
              WHEN i.included = 1 AND i.phase1_status = 'succeeded' THEN 1 ELSE 0 END), 0)
              AS selected_count
       FROM digest_review_runs r
       LEFT JOIN digest_review_items i ON i.run_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC, r.rowid DESC
      LIMIT ?`
  ).all(normalizedLimit);
}

export function setDigestReviewItemIncluded(runId, itemId, included) {
  if (typeof included !== 'boolean') throw new Error('included must be boolean');
  const update = db.prepare(
    `UPDATE digest_review_items
        SET included = ?, updated_at = datetime('now')
      WHERE id = ? AND run_id = ? AND phase1_status = 'succeeded'
        AND EXISTS (
          SELECT 1 FROM digest_review_runs
           WHERE id = ? AND status = 'awaiting_review'
        )`
  ).run(included ? 1 : 0, itemId, runId, runId);
  if (update.changes !== 1) {
    throw new Error('Digest review item inclusion is locked or item is unavailable');
  }
  return hydrateDigestReviewItem(
    db.prepare('SELECT * FROM digest_review_items WHERE id = ?').get(itemId)
  );
}

/** Atomically journal one exact Phase 1 request before any provider call. */
export function claimDigestReviewPhase1Item(runId, itemId, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Phase 1 claim requires an exact request object');
  }
  const requestJson = canonicalJson(request);
  const claim = db.transaction(() => {
    const run = db.prepare('SELECT status FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Digest review run not found');
    if (run.status !== 'phase1_processing') {
      throw new Error('Digest review run is not accepting Phase 1 work');
    }
    const item = db.prepare(
      'SELECT * FROM digest_review_items WHERE id = ? AND run_id = ?'
    ).get(itemId, runId);
    if (!item || item.phase1_status !== 'pending') {
      throw new Error('Digest review Phase 1 item is not pending');
    }
    const attemptNo = db.prepare(
      'SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM digest_review_phase1_attempts WHERE item_id = ?'
    ).get(itemId).next;
    const firstRequest = db.prepare(
      `SELECT request_sha256 FROM digest_review_phase1_attempts
        WHERE item_id = ? ORDER BY attempt_no ASC LIMIT 1`
    ).get(itemId);
    if (firstRequest && firstRequest.request_sha256 !== sha256(requestJson)) {
      throw new Error('Digest review Phase 1 retry request does not match the original request');
    }
    const attemptId = uuidv4();
    db.prepare(
      `INSERT INTO digest_review_phase1_attempts
         (id, run_id, item_id, attempt_no, request_json, request_sha256, state)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed')`
    ).run(attemptId, runId, itemId, attemptNo, requestJson, sha256(requestJson));
    const update = db.prepare(
      `UPDATE digest_review_items
          SET phase1_status = 'processing', active_phase1_attempt_id = ?,
              error = NULL, updated_at = datetime('now')
        WHERE id = ? AND run_id = ? AND phase1_status = 'pending'`
    ).run(attemptId, itemId, runId);
    if (update.changes !== 1) throw new Error('Digest review Phase 1 item claim was lost');
    return db.prepare('SELECT * FROM digest_review_phase1_attempts WHERE id = ?').get(attemptId);
  });
  return claim.immediate();
}

export function markDigestReviewPhase1CallStarted(attemptId) {
  const update = db.prepare(
    `UPDATE digest_review_phase1_attempts
        SET state = 'calling', call_started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND state = 'claimed'
        AND EXISTS (
          SELECT 1 FROM digest_review_runs r
          JOIN digest_review_items i ON i.run_id = r.id
          WHERE i.active_phase1_attempt_id = digest_review_phase1_attempts.id
            AND i.phase1_status = 'processing' AND r.status = 'phase1_processing'
        )`
  ).run(attemptId);
  if (update.changes !== 1) throw new Error('Digest review Phase 1 call claim is no longer active');
  return db.prepare('SELECT * FROM digest_review_phase1_attempts WHERE id = ?').get(attemptId);
}

export function completeDigestReviewPhase1Attempt(attemptId, {
  output,
  wordCount,
  inputTokens = 0,
  outputTokens = 0,
  costUsd = null,
}) {
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('Successful Phase 1 attempt requires output');
  }
  const complete = db.transaction(() => {
    const attempt = db.prepare(
      'SELECT * FROM digest_review_phase1_attempts WHERE id = ?'
    ).get(attemptId);
    if (!attempt || attempt.state !== 'calling') {
      throw new Error('Digest review Phase 1 attempt is not calling');
    }
    const updateItem = db.prepare(
      `UPDATE digest_review_items
          SET phase1_status = 'succeeded', active_phase1_attempt_id = NULL,
              phase1_output = ?, phase1_word_count = ?, input_tokens = ?,
              output_tokens = ?, cost_usd = ?, error = NULL, updated_at = datetime('now')
        WHERE id = ? AND run_id = ? AND phase1_status = 'processing'
          AND active_phase1_attempt_id = ?`
    ).run(
      output, wordCount, Math.max(0, Math.floor(Number(inputTokens) || 0)),
      Math.max(0, Math.floor(Number(outputTokens) || 0)), costUsd,
      attempt.item_id, attempt.run_id, attemptId
    );
    if (updateItem.changes !== 1) throw new Error('Digest review Phase 1 result ownership was lost');
    db.prepare(
      `UPDATE digest_review_phase1_attempts
          SET state = 'succeeded', output = ?, word_count = ?, input_tokens = ?,
              output_tokens = ?, cost_usd = ?, error = NULL,
              completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND state = 'calling'`
    ).run(
      output, wordCount, Math.max(0, Math.floor(Number(inputTokens) || 0)),
      Math.max(0, Math.floor(Number(outputTokens) || 0)), costUsd, attemptId
    );
    return hydrateDigestReviewItem(db.prepare(
      'SELECT * FROM digest_review_items WHERE id = ?'
    ).get(attempt.item_id));
  });
  return complete.immediate();
}

export function failDigestReviewPhase1Attempt(attemptId, error) {
  if (typeof error !== 'string' || !error.trim()) throw new Error('Phase 1 failure requires an error');
  const fail = db.transaction(() => {
    const attempt = db.prepare(
      'SELECT * FROM digest_review_phase1_attempts WHERE id = ?'
    ).get(attemptId);
    if (!attempt || attempt.state !== 'calling') {
      throw new Error('Digest review Phase 1 attempt is not calling');
    }
    const updateItem = db.prepare(
      `UPDATE digest_review_items
          SET phase1_status = 'failed', active_phase1_attempt_id = NULL,
              phase1_output = NULL, error = ?, updated_at = datetime('now')
        WHERE id = ? AND run_id = ? AND phase1_status = 'processing'
          AND active_phase1_attempt_id = ?`
    ).run(error, attempt.item_id, attempt.run_id, attemptId);
    if (updateItem.changes !== 1) throw new Error('Digest review Phase 1 failure ownership was lost');
    db.prepare(
      `UPDATE digest_review_phase1_attempts
          SET state = 'failed', error = ?, completed_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND state = 'calling'`
    ).run(error, attemptId);
    return getDigestReviewRun(attempt.run_id);
  });
  return fail.immediate();
}

export function markDigestReviewPhase1AttemptAmbiguous(attemptId, error) {
  if (typeof error !== 'string' || !error.trim()) throw new Error('Ambiguous Phase 1 attempt requires an error');
  const mark = db.transaction(() => {
    const attempt = db.prepare(
      'SELECT * FROM digest_review_phase1_attempts WHERE id = ?'
    ).get(attemptId);
    if (!attempt || !['claimed', 'calling'].includes(attempt.state)) {
      throw new Error('Digest review Phase 1 attempt is not active');
    }
    db.prepare(
      `UPDATE digest_review_phase1_attempts
          SET state = 'ambiguous', error = ?, completed_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND state IN ('claimed', 'calling')`
    ).run(error, attemptId);
    db.prepare(
      `UPDATE digest_review_items
          SET phase1_status = 'ambiguous', error = ?, updated_at = datetime('now')
        WHERE id = ? AND run_id = ? AND phase1_status = 'processing'
          AND active_phase1_attempt_id = ?`
    ).run(error, attempt.item_id, attempt.run_id, attemptId);
    db.prepare(
      `UPDATE digest_review_runs
          SET status = 'phase1_attention_required', error = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'phase1_processing'`
    ).run(error, attempt.run_id);
    return getDigestReviewRun(attempt.run_id);
  });
  return mark.immediate();
}

/** Explicit crash recovery: only never-started calls are safely requeued. */
export function recoverDigestReviewPhase1(runId) {
  const recover = db.transaction(() => {
    const run = db.prepare('SELECT * FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Digest review run not found');
    if (!['phase1_processing', 'phase1_attention_required'].includes(run.status)) {
      throw new Error('Digest review run is not recoverable in Phase 1');
    }
    const active = db.prepare(
      `SELECT * FROM digest_review_phase1_attempts
        WHERE run_id = ? AND state IN ('claimed', 'calling')`
    ).all(runId);
    for (const attempt of active) {
      if (attempt.state === 'claimed') {
        db.prepare(
          `UPDATE digest_review_phase1_attempts
              SET state = 'cancelled', error = 'Recovered before provider call',
                  completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND state = 'claimed'`
        ).run(attempt.id);
        db.prepare(
          `UPDATE digest_review_items
              SET phase1_status = 'pending', active_phase1_attempt_id = NULL,
                  error = NULL, updated_at = datetime('now')
            WHERE id = ? AND active_phase1_attempt_id = ? AND phase1_status = 'processing'`
        ).run(attempt.item_id, attempt.id);
      } else {
        const message = 'Interrupted after provider call started; operator decision required';
        db.prepare(
          `UPDATE digest_review_phase1_attempts
              SET state = 'ambiguous', error = ?, completed_at = datetime('now'),
                  updated_at = datetime('now')
            WHERE id = ? AND state = 'calling'`
        ).run(message, attempt.id);
        db.prepare(
          `UPDATE digest_review_items
              SET phase1_status = 'ambiguous', error = ?, updated_at = datetime('now')
            WHERE id = ? AND active_phase1_attempt_id = ? AND phase1_status = 'processing'`
        ).run(message, attempt.item_id, attempt.id);
      }
    }
    const ambiguous = db.prepare(
      `SELECT COUNT(*) AS count FROM digest_review_items
        WHERE run_id = ? AND phase1_status = 'ambiguous'`
    ).get(runId).count;
    db.prepare(
      `UPDATE digest_review_runs
          SET status = ?, error = ?, updated_at = datetime('now')
        WHERE id = ? AND status IN ('phase1_processing', 'phase1_attention_required')`
    ).run(
      ambiguous > 0 ? 'phase1_attention_required' : 'phase1_processing',
      ambiguous > 0 ? 'Phase 1 has ambiguous provider attempts' : null,
      runId
    );
    return getDigestReviewRun(runId);
  });
  return recover.immediate();
}

export function resolveDigestReviewPhase1Ambiguity(runId, itemId, action) {
  if (!['skip', 'retry'].includes(action)) throw new Error('Phase 1 resolution must be skip or retry');
  const resolve = db.transaction(() => {
    const run = db.prepare('SELECT * FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run || run.status !== 'phase1_attention_required') {
      throw new Error('Digest review run does not require Phase 1 attention');
    }
    const item = db.prepare(
      `SELECT * FROM digest_review_items
        WHERE id = ? AND run_id = ? AND phase1_status = 'ambiguous'`
    ).get(itemId, runId);
    if (!item) throw new Error('Digest review item is not ambiguous');
    if (action === 'retry') {
      db.prepare(
        `UPDATE digest_review_phase1_attempts
            SET state = 'superseded', updated_at = datetime('now')
          WHERE id = ? AND state = 'ambiguous'`
      ).run(item.active_phase1_attempt_id);
      db.prepare(
        `UPDATE digest_review_items
            SET phase1_status = 'pending', active_phase1_attempt_id = NULL,
                error = NULL, updated_at = datetime('now')
          WHERE id = ?`
      ).run(itemId);
    } else {
      db.prepare(
        `UPDATE digest_review_items
            SET phase1_status = 'failed', active_phase1_attempt_id = NULL,
                error = 'Operator skipped an ambiguous provider attempt',
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(itemId);
    }
    const ambiguous = db.prepare(
      `SELECT COUNT(*) AS count FROM digest_review_items
        WHERE run_id = ? AND phase1_status = 'ambiguous'`
    ).get(runId).count;
    if (ambiguous === 0) {
      db.prepare(
        `UPDATE digest_review_runs
            SET status = 'phase1_processing', error = NULL, updated_at = datetime('now')
          WHERE id = ? AND status = 'phase1_attention_required'`
      ).run(runId);
    }
    return getDigestReviewRun(runId);
  });
  return resolve.immediate();
}

export function getOpenQueueDigestReviewRun() {
  const row = db.prepare(
    `SELECT * FROM digest_review_runs
      WHERE source_kind = 'queue'
        AND status IN ('phase1_processing', 'phase1_attention_required')
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get();
  return hydrateDigestReviewRun(row);
}

export function recordDigestReviewItemResult({
  runId,
  itemId,
  status,
  output = null,
  wordCount = null,
  inputTokens = 0,
  outputTokens = 0,
  costUsd = null,
  error = null,
}) {
  if (!['succeeded', 'failed'].includes(status)) {
    throw new Error('Digest review item result must be succeeded or failed');
  }
  if (status === 'succeeded' && (typeof output !== 'string' || !output.trim() || error !== null)) {
    throw new Error('Successful digest review item requires output and no error');
  }
  if (status === 'failed' && (output !== null || typeof error !== 'string' || !error.trim())) {
    throw new Error('Failed digest review item requires an error and no output');
  }
  const update = db.prepare(
    `UPDATE digest_review_items
        SET phase1_status = ?, phase1_output = ?, phase1_word_count = ?,
            input_tokens = ?, output_tokens = ?, cost_usd = ?, error = ?,
            updated_at = datetime('now')
      WHERE id = ? AND run_id = ? AND phase1_status IN ('pending', 'processing')
        AND EXISTS (
          SELECT 1 FROM digest_review_runs
           WHERE id = ? AND status = 'phase1_processing'
        )`
  ).run(
    status, output, wordCount, Math.max(0, Math.floor(Number(inputTokens) || 0)),
    Math.max(0, Math.floor(Number(outputTokens) || 0)), costUsd, error,
    itemId, runId, runId
  );
  if (update.changes !== 1) {
    throw new Error('Digest review item result is already recorded or run is not in Phase 1');
  }
  return hydrateDigestReviewItem(
    db.prepare('SELECT * FROM digest_review_items WHERE id = ?').get(itemId)
  );
}

export function finishDigestReviewPhase1(runId) {
  const finish = db.transaction(() => {
    const run = db.prepare('SELECT * FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Digest review run not found');
    if (run.status === 'awaiting_review'
      || (run.status === 'failed' && run.phase1_completed_at)) {
      return hydrateDigestReviewRun(run);
    }
    if (run.status !== 'phase1_processing') throw new Error('Digest review run is not in Phase 1');

    const items = db.prepare(
      'SELECT * FROM digest_review_items WHERE run_id = ? ORDER BY position ASC'
    ).all(runId);
    if (items.some((item) => !['succeeded', 'failed'].includes(item.phase1_status))) {
      throw new Error('Digest review Phase 1 still has unfinished items');
    }

    if (run.source_kind !== 'rerun') {
      const updateArticle = db.prepare(
        `UPDATE articles SET status = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'digest_review' AND digest_id IS NULL`
      );
      for (const item of items) {
        if (updateArticle.run(
          item.phase1_status === 'succeeded' ? 'awaiting_review' : 'error',
          item.article_id
        ).changes !== 1) {
          throw new Error(`Digest review source article ${item.article_id} changed during Phase 1`);
        }
      }
    }

    const succeeded = items.filter((item) => item.phase1_status === 'succeeded').length;
    const nextStatus = succeeded > 0 ? 'awaiting_review' : 'failed';
    const failure = succeeded > 0 ? null : 'Phase 1 produced no successful items';
    db.prepare(
      `UPDATE digest_review_runs
          SET status = ?, error = ?, phase1_completed_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND status = 'phase1_processing'`
    ).run(nextStatus, failure, runId);
    return getDigestReviewRun(runId);
  });
  return finish.immediate();
}

export function freezeDigestReviewPhase2(runId) {
  const freeze = db.transaction(() => {
    const run = db.prepare('SELECT * FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Digest review run not found');
    if (run.result_digest_id) return getDigestReviewRun(runId);
    if (run.phase2_items_json) {
      if (sha256(run.phase2_items_json) !== run.phase2_items_sha256) {
        throw new Error('Digest review frozen Phase 2 selection is corrupt');
      }
      return getDigestReviewRun(runId);
    }
    if (run.status !== 'awaiting_review') {
      throw new Error('Digest review run is not awaiting review');
    }

    const selected = db.prepare(
      `SELECT id, article_id, position, title, url,
              title AS source_title, url AS source_url,
              phase1_output, phase1_word_count,
              input_tokens, output_tokens, cost_usd, source_sha256
         FROM digest_review_items
        WHERE run_id = ? AND included = 1 AND phase1_status = 'succeeded'
        ORDER BY position ASC`
    ).all(runId);
    if (selected.length === 0) throw new Error('Digest review Phase 2 requires at least one included item');
    const frozenJson = canonicalJson(selected);
    const update = db.prepare(
      `UPDATE digest_review_runs
          SET status = 'phase2_retryable', phase2_items_json = ?,
              phase2_items_sha256 = ?, phase2_claimed_at = datetime('now'),
              error = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'awaiting_review'`
    ).run(frozenJson, sha256(frozenJson), runId);
    if (update.changes !== 1) throw new Error('Digest review Phase 2 freeze was lost');
    return getDigestReviewRun(runId);
  });
  return freeze.immediate();
}

export function claimDigestReviewPhase2(runId, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Phase 2 claim requires an exact request object');
  }
  const requestJson = canonicalJson(request);
  const claim = db.transaction(() => {
    const run = db.prepare('SELECT * FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Digest review run not found');
    if (run.result_digest_id) return getDigestReviewRun(runId);
    if (run.status !== 'phase2_retryable' || !run.phase2_items_json) {
      throw new Error('Digest review Phase 2 is not retryable');
    }
    if (sha256(run.phase2_items_json) !== run.phase2_items_sha256) {
      throw new Error('Digest review frozen Phase 2 selection is corrupt');
    }
    const attemptNo = db.prepare(
      'SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM digest_review_phase2_attempts WHERE run_id = ?'
    ).get(runId).next;
    const firstRequest = db.prepare(
      `SELECT request_sha256 FROM digest_review_phase2_attempts
        WHERE run_id = ? ORDER BY attempt_no ASC LIMIT 1`
    ).get(runId);
    if (firstRequest && firstRequest.request_sha256 !== sha256(requestJson)) {
      throw new Error('Digest review Phase 2 retry request does not match the original request');
    }
    const attemptId = uuidv4();
    db.prepare(
      `INSERT INTO digest_review_phase2_attempts
         (id, run_id, attempt_no, selection_sha256, request_json, request_sha256,
          vendor, model, reasoning_effort, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed')`
    ).run(
      attemptId, runId, attemptNo, run.phase2_items_sha256,
      requestJson, sha256(requestJson), request.vendor, request.model,
      request.reasoningEffort ?? null
    );
    const update = db.prepare(
      `UPDATE digest_review_runs
          SET status = 'phase2_processing', error = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'phase2_retryable'`
    ).run(runId);
    if (update.changes !== 1) throw new Error('Digest review Phase 2 attempt claim was lost');
    return getDigestReviewRun(runId);
  });
  return claim.immediate();
}

export function markDigestReviewPhase2CallStarted(attemptId) {
  const update = db.prepare(
    `UPDATE digest_review_phase2_attempts
        SET state = 'calling', call_started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND state = 'claimed'
        AND EXISTS (
          SELECT 1 FROM digest_review_runs
           WHERE id = digest_review_phase2_attempts.run_id AND status = 'phase2_processing'
        )`
  ).run(attemptId);
  if (update.changes !== 1) throw new Error('Digest review Phase 2 call claim is no longer active');
  return db.prepare('SELECT * FROM digest_review_phase2_attempts WHERE id = ?').get(attemptId);
}

export function recordDigestReviewPhase2Response(attemptId, {
  content,
  inputTokens = 0,
  outputTokens = 0,
  costUsd = null,
}) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Phase 2 response requires content');
  }
  const record = db.transaction(() => {
    const attempt = db.prepare(
      'SELECT * FROM digest_review_phase2_attempts WHERE id = ?'
    ).get(attemptId);
    if (!attempt || attempt.state !== 'calling') {
      throw new Error('Digest review Phase 2 attempt is not calling');
    }
    db.prepare(
      `UPDATE digest_review_phase2_attempts
          SET state = 'response_recorded', response_text = ?, response_sha256 = ?,
              input_tokens = ?, output_tokens = ?, cost_usd = ?, error = NULL,
              response_recorded_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND state = 'calling'`
    ).run(
      content, sha256(content), Math.max(0, Math.floor(Number(inputTokens) || 0)),
      Math.max(0, Math.floor(Number(outputTokens) || 0)), costUsd, attemptId
    );
    const updateRun = db.prepare(
      `UPDATE digest_review_runs
          SET status = 'phase2_output_ready', error = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'phase2_processing'`
    ).run(attempt.run_id);
    if (updateRun.changes !== 1) throw new Error('Digest review Phase 2 response ownership was lost');
    return getDigestReviewRun(attempt.run_id);
  });
  return record.immediate();
}

export function rejectDigestReviewPhase2Attempt(attemptId, error, { retryable = false } = {}) {
  if (typeof error !== 'string' || !error.trim()) throw new Error('Phase 2 rejection requires an error');
  const reject = db.transaction(() => {
    const attempt = db.prepare(
      'SELECT * FROM digest_review_phase2_attempts WHERE id = ?'
    ).get(attemptId);
    if (!attempt || !['claimed', 'calling'].includes(attempt.state)) {
      throw new Error('Digest review Phase 2 attempt is not active');
    }
    const attemptState = retryable ? 'failed_retryable' : 'inconclusive';
    const runState = retryable ? 'phase2_retryable' : 'phase2_inconclusive';
    db.prepare(
      `UPDATE digest_review_phase2_attempts
          SET state = ?, error = ?, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND state IN ('claimed', 'calling')`
    ).run(attemptState, error, attemptId);
    db.prepare(
      `UPDATE digest_review_runs
          SET status = ?, error = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'phase2_processing'`
    ).run(runState, error, attempt.run_id);
    return getDigestReviewRun(attempt.run_id);
  });
  return reject.immediate();
}

/** Recover Phase 2 without making a provider call. */
export function recoverDigestReviewPhase2(runId) {
  const recover = db.transaction(() => {
    const run = db.prepare('SELECT * FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Digest review run not found');
    if (run.result_digest_id || ['phase2_output_ready', 'phase2_retryable', 'phase2_inconclusive'].includes(run.status)) {
      return getDigestReviewRun(runId);
    }
    if (run.status !== 'phase2_processing') {
      throw new Error('Digest review run is not recoverable in Phase 2');
    }
    const attempt = db.prepare(
      `SELECT * FROM digest_review_phase2_attempts
        WHERE run_id = ? AND state IN ('claimed', 'calling', 'response_recorded')
        ORDER BY attempt_no DESC LIMIT 1`
    ).get(runId);
    if (!attempt) throw new Error('Digest review Phase 2 active attempt is missing');
    if (attempt.state === 'response_recorded') {
      db.prepare(
        `UPDATE digest_review_runs SET status = 'phase2_output_ready', error = NULL,
            updated_at = datetime('now') WHERE id = ? AND status = 'phase2_processing'`
      ).run(runId);
    } else if (attempt.state === 'claimed') {
      db.prepare(
        `UPDATE digest_review_phase2_attempts
            SET state = 'failed_retryable', error = 'Recovered before provider call',
                completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND state = 'claimed'`
      ).run(attempt.id);
      db.prepare(
        `UPDATE digest_review_runs SET status = 'phase2_retryable',
            error = 'Recovered before provider call', updated_at = datetime('now')
          WHERE id = ? AND status = 'phase2_processing'`
      ).run(runId);
    } else {
      const error = 'Interrupted after Phase 2 provider call started; reconciliation required';
      db.prepare(
        `UPDATE digest_review_phase2_attempts
            SET state = 'inconclusive', error = ?, completed_at = datetime('now'),
                updated_at = datetime('now') WHERE id = ? AND state = 'calling'`
      ).run(error, attempt.id);
      db.prepare(
        `UPDATE digest_review_runs SET status = 'phase2_inconclusive', error = ?,
            updated_at = datetime('now') WHERE id = ? AND status = 'phase2_processing'`
      ).run(error, runId);
    }
    return getDigestReviewRun(runId);
  });
  return recover.immediate();
}

export function completeDigestReviewPhase2(runId, { date } = {}) {
  const complete = db.transaction(() => {
    const run = db.prepare('SELECT * FROM digest_review_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Digest review run not found');
    if (run.result_digest_id) return run.result_digest_id;
    if (run.status !== 'phase2_output_ready' || !run.phase2_items_json) {
      throw new Error('Digest review Phase 2 output is not ready');
    }
    if (sha256(run.phase2_items_json) !== run.phase2_items_sha256) {
      throw new Error('Digest review frozen Phase 2 selection is corrupt');
    }
    const selected = JSON.parse(run.phase2_items_json);
    if (!Array.isArray(selected) || selected.length === 0) {
      throw new Error('Digest review frozen Phase 2 selection is empty');
    }
    const attempt = db.prepare(
      `SELECT * FROM digest_review_phase2_attempts
        WHERE run_id = ? AND state = 'response_recorded'
        ORDER BY attempt_no DESC LIMIT 1`
    ).get(runId);
    if (!attempt || !attempt.response_text
      || sha256(attempt.response_text) !== attempt.response_sha256) {
      throw new Error('Digest review Phase 2 response receipt is missing or corrupt');
    }

    const phase1Usage = db.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              SUM(cost_usd) AS cost_usd,
              COUNT(cost_usd) AS priced_count,
              COUNT(*) AS item_count
         FROM digest_review_items WHERE run_id = ?`
    ).get(runId);
    const phase2Input = attempt.input_tokens;
    const phase2Output = attempt.output_tokens;
    const phase1CostKnown = phase1Usage.priced_count === phase1Usage.item_count;
    const totalCost = phase1CostKnown && attempt.cost_usd !== null
      ? Number(phase1Usage.cost_usd || 0) + Number(attempt.cost_usd)
      : null;
    const phase1CostLabel = phase1CostKnown
      ? `$${Number(phase1Usage.cost_usd || 0).toFixed(6)}`
      : 'n/a';
    const generationLog = [
      `Digest review run: ${run.id}`,
      `Phase 1: ${selected.length}/${phase1Usage.item_count} items included; input=${phase1Usage.input_tokens}; output=${phase1Usage.output_tokens}; cost=${phase1CostLabel}`,
      `Phase 2: attempt=${attempt.attempt_no}; model=${attempt.model}; input=${phase2Input}; output=${phase2Output}`,
    ].join('\n');
    const digestId = uuidv4();
    const seq = db.prepare('SELECT COALESCE(MAX(seq_number), 0) AS max FROM digests').get().max + 1;
    db.prepare(
      `INSERT INTO digests
         (id, date, part, articles_count, seq_number, content, status,
          generation_log, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, 1, ?, ?, ?, 'ready_for_review', ?, ?, ?, ?, ?)`
    ).run(
      digestId, date || new Date().toISOString().slice(0, 10), selected.length, seq,
      attempt.response_text, generationLog, attempt.model,
      phase1Usage.input_tokens + phase2Input,
      phase1Usage.output_tokens + phase2Output,
      totalCost
    );

    if (run.source_kind !== 'rerun') {
      const selectedIds = new Set(selected.map((item) => item.id));
      const items = db.prepare(
        'SELECT id, article_id, phase1_status FROM digest_review_items WHERE run_id = ?'
      ).all(runId);
      const consume = db.prepare(
        `UPDATE articles SET digest_id = ?, status = ?, updated_at = datetime('now')
          WHERE id = ? AND status IN ('awaiting_review', 'error') AND digest_id IS NULL`
      );
      for (const item of items) {
        const isIncluded = selectedIds.has(item.id) && item.phase1_status === 'succeeded';
        const finalStatus = isIncluded ? 'used'
          : (item.phase1_status === 'succeeded' ? 'excluded' : 'error');
        const attachedDigestId = isIncluded ? digestId : null;
        if (consume.run(attachedDigestId, finalStatus, item.article_id).changes !== 1) {
          throw new Error(`Digest review source article ${item.article_id} changed before completion`);
        }
      }
    }

    const update = db.prepare(
      `UPDATE digest_review_runs
          SET result_digest_id = ?, status = 'ready_for_review', error = NULL,
              completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'phase2_output_ready' AND result_digest_id IS NULL`
    ).run(digestId, runId);
    if (update.changes !== 1) throw new Error('Digest review completion was lost');
    const completeAttempt = db.prepare(
      `UPDATE digest_review_phase2_attempts
          SET state = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND state = 'response_recorded'`
    ).run(attempt.id);
    if (completeAttempt.changes !== 1) throw new Error('Digest review Phase 2 receipt completion was lost');
    return digestId;
  });
  return complete.immediate();
}

/** Return stable source snapshots for an immutable rerun. */
export function getDigestReviewSourceArticles(digestId) {
  const reviewRun = db.prepare(
    `SELECT id FROM digest_review_runs
      WHERE result_digest_id = ? AND status = 'ready_for_review'`
  ).get(digestId);
  if (reviewRun) {
    return db.prepare(
      `SELECT article_id AS id, title, url, content, position
         FROM digest_review_items
        WHERE run_id = ? AND included = 1 AND phase1_status = 'succeeded'
        ORDER BY position ASC`
    ).all(reviewRun.id);
  }

  const batchItems = db.prepare(
    `SELECT a.id, a.title, a.url, a.content, i.position
       FROM digest_batch_items i
       JOIN digest_batches b ON b.id = i.batch_id
       JOIN articles a ON a.id = i.article_id
      WHERE b.digest_id = ? ORDER BY i.position ASC`
  ).all(digestId);
  if (batchItems.length > 0) return batchItems;

  return db.prepare(
    `SELECT id, title, url, content,
            ROW_NUMBER() OVER (ORDER BY created_at ASC, rowid ASC) AS position
       FROM articles WHERE digest_id = ? ORDER BY created_at ASC, rowid ASC`
  ).all(digestId);
}

export function isDigestReferencedByReviewRun(digestId) {
  return Boolean(db.prepare(
    `SELECT 1 FROM digest_review_runs
      WHERE source_digest_id = ? OR result_digest_id = ? LIMIT 1`
  ).get(digestId, digestId));
}

function digestWithStageAccountingSql(where = '') {
  return `SELECT d.*,
    COALESCE((SELECT SUM(a.input_tokens) FROM digest_stage_artifacts a
      WHERE a.digest_id = d.id), 0) AS instagram_card_input_tokens,
    COALESCE((SELECT SUM(a.output_tokens) FROM digest_stage_artifacts a
      WHERE a.digest_id = d.id), 0) AS instagram_card_output_tokens,
    COALESCE((SELECT SUM(a.cost_usd) FROM digest_stage_artifacts a
      WHERE a.digest_id = d.id AND a.accounting_status = 'priced'), 0) AS instagram_card_cost_usd,
    EXISTS(SELECT 1 FROM digest_stage_artifacts a
      WHERE a.digest_id = d.id AND a.accounting_status != 'priced') AS instagram_card_cost_unknown,
    d.input_tokens + COALESCE((SELECT SUM(a.input_tokens) FROM digest_stage_artifacts a
      WHERE a.digest_id = d.id), 0) AS total_input_tokens,
    d.output_tokens + COALESCE((SELECT SUM(a.output_tokens) FROM digest_stage_artifacts a
      WHERE a.digest_id = d.id), 0) AS total_output_tokens,
    CASE
      WHEN d.cost_usd IS NULL
        OR EXISTS(SELECT 1 FROM digest_stage_artifacts a
          WHERE a.digest_id = d.id AND a.accounting_status != 'priced')
      THEN NULL
      ELSE d.cost_usd + COALESCE((SELECT SUM(a.cost_usd) FROM digest_stage_artifacts a
        WHERE a.digest_id = d.id AND a.accounting_status = 'priced'), 0)
    END AS total_cost_usd,
    COALESCE(d.cost_usd, 0) + COALESCE((SELECT SUM(a.cost_usd) FROM digest_stage_artifacts a
      WHERE a.digest_id = d.id AND a.accounting_status = 'priced'), 0) AS known_total_cost_usd
    FROM digests d ${where}`;
}

export function getSuccessfulDigestStageArtifact({ digestId, stage, stageVersion, sourceSha256, promptSha256 }) {
  return db.prepare(
    `SELECT * FROM digest_stage_artifacts
      WHERE digest_id = ? AND stage = ? AND stage_version = ?
        AND source_sha256 = ? AND prompt_sha256 = ? AND status = 'succeeded'
      ORDER BY attempt DESC LIMIT 1`
  ).get(digestId, stage, stageVersion, sourceSha256, promptSha256);
}

export function getLatestDigestStageArtifact({ digestId, stage, stageVersion }) {
  return db.prepare(
    `SELECT * FROM digest_stage_artifacts
      WHERE digest_id = ? AND stage = ? AND stage_version = ?
      ORDER BY attempt DESC LIMIT 1`
  ).get(digestId, stage, stageVersion);
}

/**
 * Reserve one digest-level model attempt before the provider is called. The
 * active-fingerprint index makes the reservation safe against concurrent queue
 * and manual triggers; a completed matching receipt is returned for reuse.
 */
export function startDigestStageArtifact({
  digestId,
  stage,
  stageVersion,
  sourceSha256,
  promptSha256,
  sourceEntriesJson,
  model = null,
  vendor = null,
  reasoningEffort = null,
}) {
  const start = db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM digest_stage_artifacts
        WHERE digest_id = ? AND stage = ? AND stage_version = ?
          AND source_sha256 = ? AND prompt_sha256 = ?
          AND status IN ('running', 'succeeded')
        ORDER BY attempt DESC LIMIT 1`
    ).get(digestId, stage, stageVersion, sourceSha256, promptSha256);
    if (existing) {
      return { artifact: existing, reused: existing.status === 'succeeded', inProgress: existing.status === 'running' };
    }
    const attempt = db.prepare(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
         FROM digest_stage_artifacts
        WHERE digest_id = ? AND stage = ? AND stage_version = ?`
    ).get(digestId, stage, stageVersion).attempt;
    const id = uuidv4();
    db.prepare(
      `INSERT INTO digest_stage_artifacts
        (id, digest_id, stage, stage_version, attempt, source_sha256, prompt_sha256,
         source_entries_json, model, vendor, reasoning_effort, accounting_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usage_not_reported', 'running')`
    ).run(
      id, digestId, stage, stageVersion, attempt, sourceSha256, promptSha256,
      sourceEntriesJson, model, vendor, reasoningEffort
    );
    return {
      artifact: db.prepare('SELECT * FROM digest_stage_artifacts WHERE id = ?').get(id),
      reused: false,
      inProgress: false,
    };
  });
  return start.immediate();
}

/** Finish a reserved attempt once; immutable receipt data can never be replaced. */
export function completeDigestStageArtifact(id, fields) {
  const allowed = [
    'raw_response', 'result_json', 'image_file', 'image_sha256', 'image_width',
    'image_height', 'image_bytes', 'input_tokens', 'output_tokens',
    'input_rate_usd_per_million', 'output_rate_usd_per_million', 'pricing_version',
    'cost_usd', 'accounting_status', 'status', 'error',
  ];
  const updates = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (!updates.length) throw new Error('completeDigestStageArtifact requires receipt fields');
  updates.push("updated_at = datetime('now')");
  values.push(id);
  const result = db.prepare(
    `UPDATE digest_stage_artifacts SET ${updates.join(', ')} WHERE id = ? AND status = 'running'`
  ).run(...values);
  if (result.changes !== 1) throw new Error('Digest stage artifact is no longer running');
  return db.prepare('SELECT * FROM digest_stage_artifacts WHERE id = ?').get(id);
}

// ── Digest Instagram carousel contract ─────────────────────────────────────
// The core owns the local receipt ledger. Provider/model work is intentionally
// kept in the optional pro service so an open-core build never exposes an
// accidental social-media write path.

export function getDigestInstagramCarousel({ digestId, contractVersion = null }) {
  const where = contractVersion
    ? 'WHERE digest_id = ? AND contract_version = ?'
    : 'WHERE digest_id = ?';
  const params = contractVersion ? [digestId, contractVersion] : [digestId];
  return db.prepare(
    `SELECT * FROM digest_instagram_carousels ${where} ORDER BY created_at DESC LIMIT 1`
  ).get(...params);
}

export function getDigestInstagramCarouselById(id) {
  return db.prepare('SELECT * FROM digest_instagram_carousels WHERE id = ?').get(id);
}

export function getDigestInstagramCarouselAssets(carouselId) {
  return db.prepare(
    `SELECT * FROM digest_instagram_carousel_assets WHERE carousel_id = ? ORDER BY slot ASC`
  ).all(carouselId);
}

export function getDigestInstagramCarouselTextParts(carouselId) {
  return db.prepare(
    `SELECT * FROM digest_instagram_carousel_text_parts WHERE carousel_id = ? ORDER BY part_index ASC`
  ).all(carouselId);
}

export function getDigestInstagramMetaReceipts(carouselId) {
  return db.prepare(
    `SELECT * FROM digest_instagram_meta_receipts
      WHERE carousel_id = ? ORDER BY operation ASC, ordinal ASC`
  ).all(carouselId);
}

/** The legacy published carousel is repairable without preparing or publishing another media object. */
export function getDigestInstagramCarouselByDelivery({ digestId, contractVersion, deliveryState = 'published' }) {
  if (!digestId || !contractVersion || !deliveryState) {
    throw new Error('Digest Instagram carousel delivery lookup requires digest, contract and state');
  }
  return db.prepare(
    `SELECT * FROM digest_instagram_carousels
      WHERE digest_id = ? AND contract_version = ? AND delivery_state = ? AND media_id IS NOT NULL
      ORDER BY publish_attempted_at DESC, created_at DESC LIMIT 1`
  ).get(digestId, contractVersion, deliveryState);
}

export function getDigestInstagramCommentOrderRepair(carouselId) {
  return db.prepare(
    `SELECT * FROM digest_instagram_comment_order_repairs WHERE carousel_id = ? LIMIT 1`
  ).get(carouselId);
}

export function getDigestInstagramCommentOrderRepairActions(repairId) {
  return db.prepare(
    `SELECT * FROM digest_instagram_comment_order_repair_actions
      WHERE repair_id = ? ORDER BY action ASC, logical_part_index ASC`
  ).all(repairId);
}

/** Persist one immutable, preflight-verified repair run. Existing runs are never replaced. */
export function startDigestInstagramCommentOrderRepair({
  carouselId,
  sourceReceiptsSha256,
  preflightSha256,
  preflightJson,
}) {
  if (!carouselId || !sourceReceiptsSha256 || !preflightSha256 || !preflightJson) {
    throw new Error('Digest Instagram comment-order repair requires immutable preflight evidence');
  }
  const create = db.transaction(() => {
    const existing = getDigestInstagramCommentOrderRepair(carouselId);
    if (existing) return { repair: existing, created: false };
    const id = uuidv4();
    db.prepare(
      `INSERT INTO digest_instagram_comment_order_repairs
        (id, carousel_id, state, source_receipts_sha256, preflight_sha256, preflight_json)
       VALUES (?, ?, 'ready', ?, ?, ?)`
    ).run(id, carouselId, sourceReceiptsSha256, preflightSha256, preflightJson);
    return {
      repair: db.prepare('SELECT * FROM digest_instagram_comment_order_repairs WHERE id = ?').get(id),
      created: true,
    };
  });
  return create.immediate();
}

export function setDigestInstagramCommentOrderRepairState(id, { state, error = null }) {
  if (!['ready', 'repairing', 'awaiting_reconciliation', 'completed', 'blocked'].includes(state)) {
    throw new Error('Invalid digest Instagram comment-order repair state');
  }
  const result = db.prepare(
    `UPDATE digest_instagram_comment_order_repairs
        SET state = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(state, error, id);
  if (result.changes !== 1) throw new Error('Digest Instagram comment-order repair not found');
  return db.prepare('SELECT * FROM digest_instagram_comment_order_repairs WHERE id = ?').get(id);
}

/** Persist the irreversible delete/replacement intent before the corresponding Meta request. */
export function createDigestInstagramCommentOrderRepairActionIntent({
  repairId,
  action,
  logicalPartIndex,
  originalRemoteId = null,
  requestSha256,
  requestJson,
}) {
  if (!repairId || !['delete_original', 'publish_replacement'].includes(action)
    || !Number.isInteger(logicalPartIndex) || logicalPartIndex < 1 || !requestSha256 || !requestJson) {
    throw new Error('Invalid digest Instagram comment-order repair action identity');
  }
  const create = db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM digest_instagram_comment_order_repair_actions
        WHERE repair_id = ? AND action = ? AND logical_part_index = ?`
    ).get(repairId, action, logicalPartIndex);
    if (existing) return { action: existing, created: false };
    const id = uuidv4();
    db.prepare(
      `INSERT INTO digest_instagram_comment_order_repair_actions
        (id, repair_id, action, logical_part_index, original_remote_id, request_sha256, request_json, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'intent')`
    ).run(id, repairId, action, logicalPartIndex, originalRemoteId, requestSha256, requestJson);
    return {
      action: db.prepare('SELECT * FROM digest_instagram_comment_order_repair_actions WHERE id = ?').get(id),
      created: true,
    };
  });
  return create.immediate();
}

export function completeDigestInstagramCommentOrderRepairAction(id, {
  state,
  remoteId = null,
  responseJson = null,
  error = null,
}) {
  if (!['accepted', 'unknown', 'failed', 'ambiguous', 'inconclusive'].includes(state)) {
    throw new Error('Invalid terminal digest Instagram comment-order repair action state');
  }
  const result = db.prepare(
    `UPDATE digest_instagram_comment_order_repair_actions
        SET state = ?, remote_id = ?, response_json = ?, error = ?, updated_at = datetime('now')
      WHERE id = ? AND state = 'intent'`
  ).run(state, remoteId, responseJson, error, id);
  if (result.changes !== 1) throw new Error('Digest Instagram comment-order repair action is no longer an intent');
  return db.prepare('SELECT * FROM digest_instagram_comment_order_repair_actions WHERE id = ?').get(id);
}

/** A read-only Meta proof can advance only an uncertain repair action. */
export function reconcileDigestInstagramCommentOrderRepairAction(id, {
  remoteId = null,
  responseJson = null,
}) {
  const result = db.prepare(
    `UPDATE digest_instagram_comment_order_repair_actions
        SET state = 'reconciled', remote_id = ?, response_json = ?, error = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND state IN ('intent', 'unknown')`
  ).run(remoteId, responseJson, id);
  if (result.changes !== 1) throw new Error('Digest Instagram comment-order repair action is not awaiting reconciliation');
  return db.prepare('SELECT * FROM digest_instagram_comment_order_repair_actions WHERE id = ?').get(id);
}

/**
 * Freeze a canonical linkless text snapshot and its exact caption/comments.
 * A matching digest/version/input fingerprint is reused; changed content gets
 * a separate review ledger and cannot resume an older Meta attempt.
 */
export function startDigestInstagramCarousel({
  digestId,
  contractVersion,
  digestContentSha256,
  displayText,
  displayTextSha256,
  textParts,
}) {
  if (!digestId || !contractVersion || !digestContentSha256 || !displayTextSha256) {
    throw new Error('Digest Instagram carousel requires stable digest and text fingerprints');
  }
  if (!Array.isArray(textParts) || textParts.length < 1 || textParts[0]?.partIndex !== 0) {
    throw new Error('Digest Instagram carousel requires a caption at text part 0');
  }
  const create = db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM digest_instagram_carousels
        WHERE digest_id = ? AND contract_version = ? AND digest_content_sha256 = ?`
    ).get(digestId, contractVersion, digestContentSha256);
    if (existing) return { carousel: existing, reused: true };

    const id = uuidv4();
    db.prepare(
      `INSERT INTO digest_instagram_carousels
        (id, digest_id, contract_version, digest_content_sha256, display_text, display_text_sha256)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, digestId, contractVersion, digestContentSha256, displayText, displayTextSha256);
    const insertPart = db.prepare(
      `INSERT INTO digest_instagram_carousel_text_parts
        (carousel_id, part_index, kind, text, text_sha256, codepoint_length)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const part of textParts) {
      if (!Number.isInteger(part?.partIndex) || part.partIndex < 0
        || !['caption', 'comment'].includes(part.kind) || !part.textSha256
        || !Number.isInteger(part.codepointLength) || part.codepointLength < 0) {
        throw new Error('Digest Instagram carousel received an invalid text part');
      }
      insertPart.run(id, part.partIndex, part.kind, part.text, part.textSha256, part.codepointLength);
    }
    return {
      carousel: db.prepare('SELECT * FROM digest_instagram_carousels WHERE id = ?').get(id),
      reused: false,
    };
  });
  return create.immediate();
}

/** Insert exactly one immutable reviewed slide; duplicate slots/source items fail. */
export function addDigestInstagramCarouselAsset({
  carouselId,
  slot,
  role,
  sourceNumber = null,
  sourceEntryJson,
  artifactId,
  imageFile,
  imageSha256,
  imageWidth,
  imageHeight,
  imageBytes,
}) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 9 || !artifactId || !imageFile || !imageSha256) {
    throw new Error('Digest Instagram carousel asset is incomplete');
  }
  const result = db.prepare(
    `INSERT OR IGNORE INTO digest_instagram_carousel_assets
      (carousel_id, slot, role, source_number, source_entry_json, artifact_id,
       image_file, image_sha256, image_width, image_height, image_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    carouselId, slot, role, sourceNumber, sourceEntryJson, artifactId,
    imageFile, imageSha256, imageWidth, imageHeight, imageBytes
  );
  if (result.changes === 0) {
    const existing = db.prepare(
      `SELECT * FROM digest_instagram_carousel_assets WHERE carousel_id = ? AND slot = ?`
    ).get(carouselId, slot);
    if (existing?.artifact_id === artifactId) return { asset: existing, reused: true };
    throw new Error(`Digest Instagram carousel slot ${slot} is already immutable`);
  }
  return {
    asset: db.prepare(
      `SELECT * FROM digest_instagram_carousel_assets WHERE carousel_id = ? AND slot = ?`
    ).get(carouselId, slot),
    reused: false,
  };
}

export function updateDigestInstagramCarouselPreparation(id, {
  preparationState,
  assetSetSha256 = null,
  error = null,
}) {
  if (!['preparing', 'ready', 'blocked'].includes(preparationState)) {
    throw new Error('Invalid digest Instagram carousel preparation state');
  }
  const result = db.prepare(
    `UPDATE digest_instagram_carousels
        SET preparation_state = ?, asset_set_sha256 = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(preparationState, assetSetSha256, error, id);
  if (result.changes !== 1) throw new Error('Digest Instagram carousel not found');
  return getDigestInstagramCarouselById(id);
}

/**
 * Claim the one media_publish side effect. Once an intent exists without a
 * durable media id, every later caller is reconciliation-only.
 */
export function claimDigestInstagramCarouselPublish(id, igAccountId) {
  const claim = db.transaction(() => {
    const carousel = getDigestInstagramCarouselById(id);
    if (!carousel) throw new Error('Digest Instagram carousel not found');
    if (carousel.preparation_state !== 'ready') throw new Error('Digest Instagram carousel is not ready for publishing');
    if (carousel.media_id) return { carousel, claimed: false, reason: 'media_already_known' };
    if (carousel.publish_attempted_at || carousel.delivery_state === 'awaiting_reconciliation') {
      return { carousel, claimed: false, reason: 'reconciliation_required' };
    }
    const changed = db.prepare(
      `UPDATE digest_instagram_carousels
          SET delivery_state = 'publishing', ig_account_id = ?,
              publish_attempted_at = datetime('now'), reconciliation_state = 'pending',
              updated_at = datetime('now')
        WHERE id = ? AND preparation_state = 'ready' AND media_id IS NULL
          AND publish_attempted_at IS NULL`
    ).run(igAccountId || null, id).changes;
    if (changed !== 1) return { carousel: getDigestInstagramCarouselById(id), claimed: false, reason: 'lost_race' };
    return { carousel: getDigestInstagramCarouselById(id), claimed: true, reason: null };
  });
  return claim.immediate();
}

/** Persist one intent before its Meta write. Duplicate intent means no resend. */
export function createDigestInstagramMetaReceiptIntent({
  carouselId,
  operation,
  ordinal,
  requestSha256,
  requestJson,
}) {
  if (!['media_publish', 'comment', 'comment_reply'].includes(operation) || !Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error('Invalid digest Instagram Meta receipt identity');
  }
  const create = db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM digest_instagram_meta_receipts
        WHERE carousel_id = ? AND operation = ? AND ordinal = ?`
    ).get(carouselId, operation, ordinal);
    if (existing) return { receipt: existing, created: false };
    const id = uuidv4();
    db.prepare(
      `INSERT INTO digest_instagram_meta_receipts
        (id, carousel_id, operation, ordinal, request_sha256, request_json, state)
       VALUES (?, ?, ?, ?, ?, ?, 'intent')`
    ).run(id, carouselId, operation, ordinal, requestSha256, requestJson);
    return {
      receipt: db.prepare('SELECT * FROM digest_instagram_meta_receipts WHERE id = ?').get(id),
      created: true,
    };
  });
  return create.immediate();
}

export function completeDigestInstagramMetaReceipt(id, {
  state,
  remoteId = null,
  responseJson = null,
  error = null,
}) {
  if (!['accepted', 'unknown', 'reconciled', 'failed', 'ambiguous', 'inconclusive'].includes(state)) {
    throw new Error('Invalid terminal digest Instagram Meta receipt state');
  }
  const result = db.prepare(
    `UPDATE digest_instagram_meta_receipts
        SET state = ?, remote_id = ?, response_json = ?, error = ?, updated_at = datetime('now')
      WHERE id = ? AND state = 'intent'`
  ).run(state, remoteId, responseJson, error, id);
  if (result.changes !== 1) throw new Error('Digest Instagram Meta receipt is no longer an intent');
  return db.prepare('SELECT * FROM digest_instagram_meta_receipts WHERE id = ?').get(id);
}

/** A read-only Meta reconciliation may advance only an uncertain prior intent. */
export function reconcileDigestInstagramMetaReceipt(id, {
  remoteId,
  responseJson = null,
}) {
  if (!remoteId) throw new Error('Digest Instagram reconciliation requires a remote id');
  const result = db.prepare(
    `UPDATE digest_instagram_meta_receipts
        SET state = 'reconciled', remote_id = ?, response_json = ?, error = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND state = 'unknown'`
  ).run(remoteId, responseJson, id);
  if (result.changes !== 1) throw new Error('Digest Instagram Meta receipt is not awaiting reconciliation');
  return db.prepare('SELECT * FROM digest_instagram_meta_receipts WHERE id = ?').get(id);
}

export function setDigestInstagramCarouselDeliveryState(id, {
  deliveryState,
  mediaId = undefined,
  reconciliationState = undefined,
  error = undefined,
}) {
  if (!['not_started', 'publishing', 'partial', 'awaiting_reconciliation', 'published', 'blocked'].includes(deliveryState)) {
    throw new Error('Invalid digest Instagram carousel delivery state');
  }
  const fields = ['delivery_state = ?', "updated_at = datetime('now')"];
  const values = [deliveryState];
  if (mediaId !== undefined) {
    fields.push('media_id = ?', "media_published_at = CASE WHEN ? IS NULL THEN media_published_at ELSE datetime('now') END");
    values.push(mediaId, mediaId);
  }
  if (reconciliationState !== undefined) {
    fields.push('reconciliation_state = ?');
    values.push(reconciliationState);
  }
  if (error !== undefined) {
    fields.push('error = ?');
    values.push(error);
  }
  values.push(id);
  const result = db.prepare(
    `UPDATE digest_instagram_carousels SET ${fields.join(', ')} WHERE id = ?`
  ).run(...values);
  if (result.changes !== 1) throw new Error('Digest Instagram carousel not found');
  return getDigestInstagramCarouselById(id);
}

// ── Immutable legacy-carousel republication delivery ledger ────────────────

export function getDigestInstagramRepublication({ digestId, sourceCarouselId = null } = {}) {
  if (!digestId) throw new Error('Digest Instagram republication requires a digest id');
  if (sourceCarouselId) {
    return db.prepare(
      `SELECT * FROM digest_instagram_republications
        WHERE digest_id = ? AND source_carousel_id = ? LIMIT 1`
    ).get(digestId, sourceCarouselId);
  }
  return db.prepare(
    `SELECT * FROM digest_instagram_republications
      WHERE digest_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(digestId);
}

export function getDigestInstagramRepublicationReceipts(republicationId) {
  return db.prepare(
    `SELECT * FROM digest_instagram_republication_receipts
      WHERE republication_id = ? ORDER BY operation ASC, ordinal ASC`
  ).all(republicationId);
}

/** Create or reuse the one replacement delivery ledger for one immutable source carousel. */
export function startDigestInstagramRepublication({
  digestId,
  sourceCarouselId,
  sourceAssetSetSha256,
  sourceTextSetSha256,
  sourceMediaId,
}) {
  if (!digestId || !sourceCarouselId || !sourceAssetSetSha256 || !sourceTextSetSha256 || !sourceMediaId) {
    throw new Error('Digest Instagram republication requires immutable source evidence');
  }
  const create = db.transaction(() => {
    const existing = getDigestInstagramRepublication({ digestId, sourceCarouselId });
    if (existing) return { republication: existing, created: false };
    const id = uuidv4();
    db.prepare(
      `INSERT INTO digest_instagram_republications
        (id, digest_id, source_carousel_id, source_asset_set_sha256, source_text_set_sha256, source_media_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, digestId, sourceCarouselId, sourceAssetSetSha256, sourceTextSetSha256, sourceMediaId);
    return {
      republication: db.prepare('SELECT * FROM digest_instagram_republications WHERE id = ?').get(id),
      created: true,
    };
  });
  return create.immediate();
}

/** Persist the exact read-only absence proof before a one-shot replacement write. */
export function recordDigestInstagramRepublicationRetiredMediaProof(id, {
  proofSha256,
  proofJson,
}) {
  if (!proofSha256 || !proofJson) throw new Error('Retired media proof requires immutable evidence');
  const result = db.prepare(
    `UPDATE digest_instagram_republications
        SET retired_media_proof_sha256 = ?, retired_media_proof_json = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(proofSha256, proofJson, id);
  if (result.changes !== 1) throw new Error('Digest Instagram republication not found');
  return db.prepare('SELECT * FROM digest_instagram_republications WHERE id = ?').get(id);
}

/** Atomically reserve the replacement run's one permitted media_publish call. */
export function claimDigestInstagramRepublicationPublish(id, igAccountId) {
  const claim = db.transaction(() => {
    const republication = db.prepare('SELECT * FROM digest_instagram_republications WHERE id = ?').get(id);
    if (!republication) throw new Error('Digest Instagram republication not found');
    if (republication.media_id) return { republication, claimed: false, reason: 'media_already_known' };
    if (republication.publish_attempted_at || republication.delivery_state === 'awaiting_reconciliation') {
      return { republication, claimed: false, reason: 'reconciliation_required' };
    }
    if (republication.delivery_state !== 'prepared') {
      return { republication, claimed: false, reason: 'not_ready' };
    }
    const changed = db.prepare(
      `UPDATE digest_instagram_republications
          SET delivery_state = 'publishing', ig_account_id = ?, publish_attempted_at = datetime('now'),
              reconciliation_state = 'pending', updated_at = datetime('now')
        WHERE id = ? AND delivery_state = 'prepared' AND media_id IS NULL AND publish_attempted_at IS NULL`
    ).run(igAccountId || null, id).changes;
    if (changed !== 1) {
      return { republication: db.prepare('SELECT * FROM digest_instagram_republications WHERE id = ?').get(id), claimed: false, reason: 'lost_race' };
    }
    return {
      republication: db.prepare('SELECT * FROM digest_instagram_republications WHERE id = ?').get(id),
      claimed: true,
      reason: null,
    };
  });
  return claim.immediate();
}

export function createDigestInstagramRepublicationReceiptIntent({
  republicationId,
  operation,
  ordinal,
  requestSha256,
  requestJson,
}) {
  if (!republicationId || !['media_publish', 'comment', 'comment_reply'].includes(operation)
    || !Number.isInteger(ordinal) || ordinal < 0 || !requestSha256 || !requestJson) {
    throw new Error('Invalid digest Instagram republication receipt identity');
  }
  const create = db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM digest_instagram_republication_receipts
        WHERE republication_id = ? AND operation = ? AND ordinal = ?`
    ).get(republicationId, operation, ordinal);
    if (existing) return { receipt: existing, created: false };
    const id = uuidv4();
    db.prepare(
      `INSERT INTO digest_instagram_republication_receipts
        (id, republication_id, operation, ordinal, request_sha256, request_json, state)
       VALUES (?, ?, ?, ?, ?, ?, 'intent')`
    ).run(id, republicationId, operation, ordinal, requestSha256, requestJson);
    return {
      receipt: db.prepare('SELECT * FROM digest_instagram_republication_receipts WHERE id = ?').get(id),
      created: true,
    };
  });
  return create.immediate();
}

export function completeDigestInstagramRepublicationReceipt(id, {
  state,
  remoteId = null,
  responseJson = null,
  error = null,
}) {
  if (!['accepted', 'unknown', 'reconciled', 'failed', 'ambiguous', 'inconclusive'].includes(state)) {
    throw new Error('Invalid terminal digest Instagram republication receipt state');
  }
  const result = db.prepare(
    `UPDATE digest_instagram_republication_receipts
        SET state = ?, remote_id = ?, response_json = ?, error = ?, updated_at = datetime('now')
      WHERE id = ? AND state = 'intent'`
  ).run(state, remoteId, responseJson, error, id);
  if (result.changes !== 1) throw new Error('Digest Instagram republication receipt is no longer an intent');
  return db.prepare('SELECT * FROM digest_instagram_republication_receipts WHERE id = ?').get(id);
}

export function reconcileDigestInstagramRepublicationReceipt(id, {
  remoteId,
  responseJson = null,
}) {
  if (!remoteId) throw new Error('Digest Instagram republication reconciliation requires a remote id');
  const result = db.prepare(
    `UPDATE digest_instagram_republication_receipts
        SET state = 'reconciled', remote_id = ?, response_json = ?, error = NULL, updated_at = datetime('now')
      WHERE id = ? AND state = 'unknown'`
  ).run(remoteId, responseJson, id);
  if (result.changes !== 1) throw new Error('Digest Instagram republication receipt is not awaiting reconciliation');
  return db.prepare('SELECT * FROM digest_instagram_republication_receipts WHERE id = ?').get(id);
}

export function setDigestInstagramRepublicationDeliveryState(id, {
  deliveryState,
  mediaId = undefined,
  reconciliationState = undefined,
  error = undefined,
}) {
  if (!['prepared', 'publishing', 'partial', 'awaiting_reconciliation', 'published', 'blocked'].includes(deliveryState)) {
    throw new Error('Invalid digest Instagram republication delivery state');
  }
  const fields = ['delivery_state = ?', "updated_at = datetime('now')"];
  const values = [deliveryState];
  if (mediaId !== undefined) {
    fields.push('media_id = ?', "media_published_at = CASE WHEN ? IS NULL THEN media_published_at ELSE datetime('now') END");
    values.push(mediaId, mediaId);
  }
  if (reconciliationState !== undefined) {
    fields.push('reconciliation_state = ?');
    values.push(reconciliationState);
  }
  if (error !== undefined) {
    fields.push('error = ?');
    values.push(error);
  }
  values.push(id);
  const result = db.prepare(
    `UPDATE digest_instagram_republications SET ${fields.join(', ')} WHERE id = ?`
  ).run(...values);
  if (result.changes !== 1) throw new Error('Digest Instagram republication not found');
  return db.prepare('SELECT * FROM digest_instagram_republications WHERE id = ?').get(id);
}

export function getArticlesByDigestId(digestId) {
  return db.prepare(
    'SELECT * FROM articles WHERE digest_id = ? ORDER BY created_at ASC'
  ).all(digestId);
}

export function getSuccessfulStageArtifact({ articleId, stage, stageVersion, rootInputSha256, promptSha256 }) {
  return db.prepare(
    `SELECT * FROM article_stage_artifacts
      WHERE article_id = ? AND stage = ? AND stage_version = ?
        AND root_input_sha256 = ? AND prompt_sha256 = ? AND status = 'succeeded'
      ORDER BY attempt DESC LIMIT 1`
  ).get(articleId, stage, stageVersion, rootInputSha256, promptSha256);
}

/**
 * Persist an immutable stage receipt. A retry never overwrites a previous
 * output: it allocates the next attempt for the article/stage/version tuple.
 */
export function createStageArtifact({
  articleId,
  stage,
  stageVersion,
  inputSha256,
  rootInputSha256 = inputSha256,
  promptSha256,
  content = null,
  wordCount = null,
  model = null,
  vendor = null,
  reasoningEffort = null,
  inputTokens = 0,
  outputTokens = 0,
  costUsd = null,
  status,
  error = null,
}) {
  // A retry may be triggered by the HTTP route and the queue at nearly the
  // same time. Reserve the write lock before computing `attempt`, otherwise
  // two callers can both choose the same immutable receipt number.
  const create = db.transaction(() => {
    const nextAttempt = db.prepare(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
         FROM article_stage_artifacts
        WHERE article_id = ? AND stage = ? AND stage_version = ?`
    ).get(articleId, stage, stageVersion).attempt;
    const id = uuidv4();
    db.prepare(
      `INSERT INTO article_stage_artifacts
         (id, article_id, stage, stage_version, attempt, input_sha256, root_input_sha256, prompt_sha256,
          content, word_count, model, vendor, reasoning_effort, input_tokens,
          output_tokens, cost_usd, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, articleId, stage, stageVersion, nextAttempt, inputSha256, rootInputSha256, promptSha256,
      content, wordCount, model, vendor, reasoningEffort, inputTokens,
      outputTokens, costUsd, status, error
    );
    return db.prepare('SELECT * FROM article_stage_artifacts WHERE id = ?').get(id);
  });
  return create.immediate();
}

export function getLatestCollectingBatch() {
  return db.prepare(
    `SELECT b.*, COUNT(i.article_id) AS items_count
       FROM digest_batches b
       LEFT JOIN digest_batch_items i ON i.batch_id = b.id
      WHERE b.status = 'collecting'
      GROUP BY b.id
      ORDER BY b.created_at ASC
      LIMIT 1`
  ).get();
}

/** The exact number of new, completed articles still required to close the batch. */
export function getCollectingBatchNeed() {
  const batch = getLatestCollectingBatch();
  if (!batch) return 30;
  return Math.max(0, batch.target_size - batch.items_count);
}

export function getBatch(batchId) {
  return db.prepare(
    `SELECT b.*, COUNT(i.article_id) AS items_count
       FROM digest_batches b
       LEFT JOIN digest_batch_items i ON i.batch_id = b.id
      WHERE b.id = ?
      GROUP BY b.id`
  ).get(batchId);
}

export function getBatchItems(batchId) {
  return db.prepare(
    `SELECT i.*, a.url, a.title
       FROM digest_batch_items i
       JOIN articles a ON a.id = i.article_id
      WHERE i.batch_id = ?
      ORDER BY i.position ASC`
  ).all(batchId);
}

/**
 * Add one complete final Russian article to the only open batch. The immediate
 * transaction gives each item a stable ordinal and prevents duplicate queue
 * runs from filling the same slot twice.
 */
export function appendArticleToCollectingBatch({ articleId, finalArtifactId, content, leaseId = null, targetSize = 30 }) {
  const append = db.transaction(() => {
    let batch = db.prepare(
      `SELECT b.*, COUNT(i.article_id) AS items_count
         FROM digest_batches b
         LEFT JOIN digest_batch_items i ON i.batch_id = b.id
        WHERE b.status = 'collecting'
        GROUP BY b.id
        ORDER BY b.created_at ASC
        LIMIT 1`
    ).get();

    if (!batch) {
      const id = uuidv4();
      db.prepare(
        `INSERT INTO digest_batches (id, status, target_size) VALUES (?, 'collecting', ?)`
      ).run(id, targetSize);
      batch = { id, status: 'collecting', target_size: targetSize, items_count: 0 };
    }

    const existing = db.prepare(
      'SELECT * FROM digest_batch_items WHERE batch_id = ? AND article_id = ?'
    ).get(batch.id, articleId);
    if (existing) return { batch: getBatch(batch.id), item: existing, duplicate: true };

    if (batch.items_count >= batch.target_size) {
      throw new Error('Collecting batch is already full');
    }

    const finalArtifact = db.prepare(
      `SELECT id FROM article_stage_artifacts
        WHERE id = ? AND article_id = ? AND stage = 'final_russian' AND status = 'succeeded'`
    ).get(finalArtifactId, articleId);
    if (!finalArtifact) throw new Error('Final Russian artifact is not a successful receipt for this article');

    const article = db.prepare('SELECT status, digest_id, processing_lease_id, processing_lease_expires_at FROM articles WHERE id = ?').get(articleId);
    if (!article || article.digest_id) throw new Error('Article is unavailable for batch append');
    if (leaseId && (
      article.status !== 'processing'
      || article.processing_lease_id !== leaseId
      || article.processing_lease_expires_at <= Date.now()
    )) {
      throw new Error('Processing lease lost before batch append');
    }

    const position = batch.items_count + 1;
    db.prepare(
      `INSERT INTO digest_batch_items (batch_id, article_id, position, final_artifact_id, content)
       VALUES (?, ?, ?, ?, ?)`
    ).run(batch.id, articleId, position, finalArtifactId, content);
    db.prepare(
      `UPDATE articles
          SET status = 'batched', processing_lease_id = NULL,
              processing_lease_expires_at = NULL, updated_at = datetime('now')
        WHERE id = ?`
    ).run(articleId);

    return {
      batch: getBatch(batch.id),
      item: db.prepare('SELECT * FROM digest_batch_items WHERE batch_id = ? AND article_id = ?').get(batch.id, articleId),
      duplicate: false,
    };
  });
  return append.immediate();
}

/**
 * Atomically create the review-only digest from a complete batch and consume
 * its items. It deliberately has no publisher call or delivery side effect.
 */
export function finalizeCollectingBatch({ batchId, date, content, generationLog, model, inputTokens = 0, outputTokens = 0, costUsd = null }) {
  const finalize = db.transaction(() => {
    const batch = getBatch(batchId);
    if (!batch) throw new Error('Batch not found');
    if (batch.status === 'ready_for_review') return batch.digest_id;
    if (batch.status !== 'collecting' || batch.items_count !== batch.target_size) {
      throw new Error(`Batch ${batchId} is not complete (${batch?.items_count || 0}/${batch?.target_size || 30})`);
    }

    const items = getBatchItems(batchId);
    if (items.length !== batch.target_size || items.some((item, index) => item.position !== index + 1)) {
      throw new Error(`Batch item positions are not exactly 1..${batch.target_size}`);
    }

    const id = uuidv4();
    const seq = db.prepare('SELECT COALESCE(MAX(seq_number), 0) AS max FROM digests').get().max + 1;
    db.prepare(
      `INSERT INTO digests
         (id, date, part, articles_count, seq_number, content, status,
          generation_log, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, 1, ?, ?, ?, 'ready_for_review', ?, ?, ?, ?, ?)`
    ).run(id, date, items.length, seq, content, generationLog, model, inputTokens, outputTokens, costUsd);

    const consume = db.prepare(
      `UPDATE articles SET digest_id = ?, status = 'used', updated_at = datetime('now')
        WHERE id = ? AND digest_id IS NULL AND status = 'batched'`
    );
    for (const item of items) {
      if (consume.run(id, item.article_id).changes !== 1) {
        throw new Error('Batch item changed before review digest finalization');
      }
    }
    db.prepare(
      `UPDATE digest_batches
          SET status = 'ready_for_review', digest_id = ?, finalized_at = datetime('now')
        WHERE id = ? AND status = 'collecting'`
    ).run(id, batchId);
    return id;
  });
  return finalize.immediate();
}

/** Aggregate every billed model receipt that belongs to a review batch. */
export function getBatchUsage(batchId) {
  return db.prepare(
    `SELECT
       COALESCE(SUM(a.input_tokens), 0) AS input_tokens,
       COALESCE(SUM(a.output_tokens), 0) AS output_tokens,
       COALESCE(SUM(a.cost_usd), 0) AS cost_usd
     FROM article_stage_artifacts a
     JOIN digest_batch_items i ON i.article_id = a.article_id
    WHERE i.batch_id = ? AND a.model IS NOT NULL`
  ).get(batchId);
}

export function deleteArticle(id) {
  // Review-ledger entries are intentionally immutable. Deleting one article
  // would leave a collecting or review-ready digest with a missing numbered
  // item, so the route reports a clear conflict instead of corrupting history.
  const batch = db.prepare(
    `SELECT b.id, b.status
       FROM digest_batch_items AS item
       JOIN digest_batches AS b ON b.id = item.batch_id
      WHERE item.article_id = ?
      LIMIT 1`
  ).get(id);
  if (batch) {
    return { changes: 0, blockedByBatch: batch };
  }

  const remove = db.transaction(() => {
    // Failed experimental attempts may have immutable stage receipts without
    // belonging to a review batch. Removing those receipts first keeps article
    // deletion available after the production rollback.
    db.prepare('DELETE FROM article_stage_artifacts WHERE article_id = ?').run(id);
    return db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  });
  return remove.immediate();
}

// source_posts data access moved to the pro cluster (src/pro/db/source-posts.js).
// Core owns only the shared connection (getDb) and the core tables. The pro
// build creates + queries source_posts via the handle returned by getDb().
