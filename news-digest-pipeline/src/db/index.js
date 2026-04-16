import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

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
    'facebook_post_id', 'telegram_message_id', 'youtube_post_id', 'articles_count'];
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
  return db.prepare('SELECT * FROM digests WHERE id = ?').get(id);
}

export function getDigests(filters = {}) {
  let query = 'SELECT * FROM digests';
  const params = [];

  if (filters.status) {
    query += ' WHERE status = ?';
    params.push(filters.status);
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return db.prepare(query).all(...params);
}

export function getArticlesByDigestId(digestId) {
  return db.prepare(
    'SELECT * FROM articles WHERE digest_id = ? ORDER BY created_at ASC'
  ).all(digestId);
}

export function deleteArticle(id) {
  return db.prepare('DELETE FROM articles WHERE id = ?').run(id);
}
