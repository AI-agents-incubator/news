CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  content TEXT,
  source TEXT DEFAULT 'extension',
  status TEXT DEFAULT 'new',
  commentary TEXT,
  digest_id TEXT,
  fetch_error TEXT,
  fetch_attempts INTEGER DEFAULT 0,
  processing_lease_id TEXT,
  processing_lease_expires_at INTEGER,
  source_chat_id TEXT,
  source_message_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id)
);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  date TEXT,
  part INTEGER DEFAULT 1,
  seq_number INTEGER,
  articles_count INTEGER DEFAULT 0,
  content TEXT,
  status TEXT DEFAULT 'draft',
  generation_log TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL,
  published_at TEXT,
  facebook_post_id TEXT,
  telegram_message_id TEXT,
  youtube_post_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- The classic digest review flow is a versioned two-phase workflow. A run
-- snapshots the exact settings and source articles before any model result is
-- recorded, so reruns never overwrite the original digest or article copy.
CREATE TABLE IF NOT EXISTS digest_review_runs (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('queue', 'manual', 'rerun')),
  source_digest_id TEXT,
  result_digest_id TEXT UNIQUE,
  source_order_kind TEXT NOT NULL DEFAULT 'claimed_order',
  settings_json TEXT NOT NULL,
  settings_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'phase1_processing', 'phase1_attention_required', 'awaiting_review',
    'phase2_retryable', 'phase2_processing', 'phase2_output_ready',
    'phase2_inconclusive', 'ready_for_review', 'failed'
  )),
  lease_id TEXT,
  phase2_items_json TEXT,
  phase2_items_sha256 TEXT,
  error TEXT,
  phase1_completed_at TEXT,
  phase2_claimed_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_digest_id) REFERENCES digests(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_digest_id) REFERENCES digests(id) ON DELETE RESTRICT,
  CHECK((source_kind = 'rerun' AND source_digest_id IS NOT NULL AND lease_id IS NULL)
    OR (source_kind = 'queue' AND source_digest_id IS NULL AND lease_id IS NOT NULL)
    OR (source_kind = 'manual' AND source_digest_id IS NULL)),
  CHECK((phase2_items_json IS NULL AND phase2_items_sha256 IS NULL)
    OR (phase2_items_json IS NOT NULL AND phase2_items_sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS digest_review_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position > 0),
  title TEXT,
  url TEXT NOT NULL,
  content TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 1 CHECK(included IN (0, 1)),
  phase1_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(phase1_status IN ('pending', 'processing', 'ambiguous', 'succeeded', 'failed')),
  active_phase1_attempt_id TEXT,
  phase1_output TEXT,
  phase1_word_count INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  cost_usd REAL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(run_id, article_id),
  UNIQUE(run_id, position),
  FOREIGN KEY (run_id) REFERENCES digest_review_runs(id) ON DELETE RESTRICT,
  CHECK((phase1_status = 'succeeded' AND phase1_output IS NOT NULL AND error IS NULL)
    OR (phase1_status = 'failed' AND phase1_output IS NULL AND error IS NOT NULL)
    OR (phase1_status = 'ambiguous' AND phase1_output IS NULL AND error IS NOT NULL)
    OR (phase1_status IN ('pending', 'processing') AND phase1_output IS NULL AND error IS NULL))
);

-- Every paid Phase 1 call has a durable request and state transition. A crash
-- before call_started_at is safe to requeue; a crash after it is ambiguous and
-- requires an explicit operator decision before another provider call.
CREATE TABLE IF NOT EXISTS digest_review_phase1_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
  request_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'claimed', 'calling', 'succeeded', 'failed', 'ambiguous',
    'cancelled', 'superseded'
  )),
  output TEXT,
  word_count INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  cost_usd REAL,
  error TEXT,
  call_started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(item_id, attempt_no),
  FOREIGN KEY (run_id) REFERENCES digest_review_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id) REFERENCES digest_review_items(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_review_phase1_active_attempt
  ON digest_review_phase1_attempts(item_id)
  WHERE state IN ('claimed', 'calling');

-- Phase 2 freezes its selection once and journals each exact model request.
-- The response is persisted before the local digest transaction, so a crash
-- after the provider returns can be finalized without a second paid call.
CREATE TABLE IF NOT EXISTS digest_review_phase2_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
  selection_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  state TEXT NOT NULL CHECK(state IN (
    'claimed', 'calling', 'response_recorded', 'failed_retryable',
    'inconclusive', 'completed'
  )),
  response_text TEXT,
  response_sha256 TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  cost_usd REAL,
  error TEXT,
  call_started_at TEXT,
  response_recorded_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(run_id, attempt_no),
  FOREIGN KEY (run_id) REFERENCES digest_review_runs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_review_phase2_active_attempt
  ON digest_review_phase2_attempts(run_id)
  WHERE state IN ('claimed', 'calling', 'response_recorded');

CREATE INDEX IF NOT EXISTS idx_digest_review_runs_status_created
  ON digest_review_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_digest_review_runs_source_digest
  ON digest_review_runs(source_digest_id);
CREATE INDEX IF NOT EXISTS idx_digest_review_items_run_position
  ON digest_review_items(run_id, position);

-- A digest-level model stage is not an article stage: its source is the
-- assembled digest and its output can be a reusable delivery asset. Keep a
-- durable, per-attempt receipt so the Instagram card can be reviewed,
-- accounted for and reused without another model call.
CREATE TABLE IF NOT EXISTS digest_stage_artifacts (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  stage_version TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  source_sha256 TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  source_entries_json TEXT NOT NULL,
  raw_response TEXT,
  result_json TEXT,
  image_file TEXT,
  image_sha256 TEXT,
  image_width INTEGER,
  image_height INTEGER,
  image_bytes INTEGER,
  model TEXT,
  vendor TEXT,
  reasoning_effort TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  input_rate_usd_per_million REAL,
  output_rate_usd_per_million REAL,
  pricing_version TEXT,
  cost_usd REAL,
  accounting_status TEXT NOT NULL DEFAULT 'usage_not_reported',
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_stage_attempt
  ON digest_stage_artifacts(digest_id, stage, stage_version, attempt);
CREATE INDEX IF NOT EXISTS idx_digest_stage_success
  ON digest_stage_artifacts(digest_id, stage, stage_version, status, created_at);
-- A second queue/manual trigger must reuse a completed artifact or observe the
-- in-flight claim. It must never make the same expensive model call twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_stage_active_fingerprint
  ON digest_stage_artifacts(digest_id, stage, stage_version, source_sha256, prompt_sha256)
  WHERE status IN ('running', 'succeeded');

-- A digest carousel is its own durable delivery contract. It freezes the
-- linkless display text and exact parts without changing the source digest.
CREATE TABLE IF NOT EXISTS digest_instagram_carousels (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  digest_content_sha256 TEXT NOT NULL,
  display_text TEXT NOT NULL,
  display_text_sha256 TEXT NOT NULL,
  asset_set_sha256 TEXT,
  preparation_state TEXT NOT NULL DEFAULT 'preparing',
  delivery_state TEXT NOT NULL DEFAULT 'not_started',
  ig_account_id TEXT,
  media_id TEXT,
  media_published_at TEXT,
  publish_attempted_at TEXT,
  reconciliation_state TEXT NOT NULL DEFAULT 'not_required',
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(digest_id, contract_version, digest_content_sha256),
  FOREIGN KEY (digest_id) REFERENCES digests(id) ON DELETE RESTRICT
);

-- Every row is one reviewed, immutable slide. Slot 0 is the cover; slots 1..9
-- are distinct source-bound model cards. Successful assets are never replaced.
CREATE TABLE IF NOT EXISTS digest_instagram_carousel_assets (
  carousel_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 9),
  role TEXT NOT NULL CHECK(role IN ('cover', 'item')),
  source_number INTEGER,
  source_entry_json TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  image_file TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  image_width INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  image_bytes INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (carousel_id, slot),
  UNIQUE(artifact_id),
  FOREIGN KEY (carousel_id) REFERENCES digest_instagram_carousels(id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id) REFERENCES digest_stage_artifacts(id) ON DELETE RESTRICT,
  CHECK((role = 'cover' AND slot = 0 AND source_number IS NULL)
    OR (role = 'item' AND slot BETWEEN 1 AND 9 AND source_number IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_instagram_asset_source
  ON digest_instagram_carousel_assets(carousel_id, source_number)
  WHERE source_number IS NOT NULL;

-- The publisher receives frozen parts rather than splitting a retry-time copy
-- of the digest. Part 0 is the caption; all remaining rows are comments.
CREATE TABLE IF NOT EXISTS digest_instagram_carousel_text_parts (
  carousel_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('caption', 'comment')),
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  codepoint_length INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (carousel_id, part_index),
  FOREIGN KEY (carousel_id) REFERENCES digest_instagram_carousels(id) ON DELETE RESTRICT,
  CHECK((part_index = 0 AND kind = 'caption') OR (part_index > 0 AND kind = 'comment'))
);

-- Intent is recorded before each irreversible Meta write. `comment` is the
-- one top-level continuation root; `comment_reply` is every exact frozen part
-- below it. Unknown results are reconciliation-only and never authorize a
-- duplicate write.
CREATE TABLE IF NOT EXISTS digest_instagram_meta_receipts (
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
CREATE INDEX IF NOT EXISTS idx_digest_instagram_carousel_lookup
  ON digest_instagram_carousels(digest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_digest_instagram_receipt_lookup
  ON digest_instagram_meta_receipts(carousel_id, operation, ordinal);

-- A human-deleted legacy post can be replaced only through a new delivery
-- ledger. It references the original immutable carousel assets/text by id and
-- checksum; it never copies, re-generates, or mutates those source records.
CREATE TABLE IF NOT EXISTS digest_instagram_republications (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL,
  source_carousel_id TEXT NOT NULL UNIQUE,
  source_asset_set_sha256 TEXT NOT NULL,
  source_text_set_sha256 TEXT NOT NULL,
  source_media_id TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'prepared',
  ig_account_id TEXT,
  media_id TEXT,
  media_published_at TEXT,
  publish_attempted_at TEXT,
  reconciliation_state TEXT NOT NULL DEFAULT 'not_required',
  retired_media_proof_sha256 TEXT,
  retired_media_proof_json TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_carousel_id) REFERENCES digest_instagram_carousels(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_digest_instagram_republication_digest
  ON digest_instagram_republications(digest_id, created_at DESC);

-- Intent/receipt ownership is the replacement delivery run, never the legacy
-- source carousel. Replies form one canonical continuation thread below part 1.
CREATE TABLE IF NOT EXISTS digest_instagram_republication_receipts (
  id TEXT PRIMARY KEY,
  republication_id TEXT NOT NULL,
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
  UNIQUE(republication_id, operation, ordinal),
  FOREIGN KEY (republication_id) REFERENCES digest_instagram_republications(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_digest_instagram_republication_receipts
  ON digest_instagram_republication_receipts(republication_id, operation, ordinal);

-- A comment-order repair is a separate, append-only corrective delivery ledger
-- for an already-published legacy carousel. It never changes the original
-- carousel receipts or permits another media_publish. The frozen preflight
-- records exactly which self-authored comments were proven before any delete.
CREATE TABLE IF NOT EXISTS digest_instagram_comment_order_repairs (
  id TEXT PRIMARY KEY,
  carousel_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('ready', 'repairing', 'awaiting_reconciliation', 'completed', 'blocked')),
  source_receipts_sha256 TEXT NOT NULL,
  preflight_sha256 TEXT NOT NULL,
  preflight_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (carousel_id) REFERENCES digest_instagram_carousels(id) ON DELETE RESTRICT
);

-- Every delete/replacement write has its own intent before Meta is contacted.
-- `logical_part_index` is canonical reader order while replacement POSTs run
-- descending physically so newest-first Instagram comments read 1..N.
CREATE TABLE IF NOT EXISTS digest_instagram_comment_order_repair_actions (
  id TEXT PRIMARY KEY,
  repair_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('delete_original', 'publish_replacement')),
  logical_part_index INTEGER NOT NULL CHECK(logical_part_index > 0),
  original_remote_id TEXT,
  request_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('intent', 'accepted', 'unknown', 'reconciled', 'failed', 'ambiguous', 'inconclusive')),
  remote_id TEXT,
  response_json TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(repair_id, action, logical_part_index),
  FOREIGN KEY (repair_id) REFERENCES digest_instagram_comment_order_repairs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_digest_instagram_repair_actions_lookup
  ON digest_instagram_comment_order_repair_actions(repair_id, action, logical_part_index);

-- The editorial pipeline persists every model-produced stage independently.
-- Rows are append-only receipts: a retry produces a new attempt instead of
-- replacing an earlier result, so a review can always reconstruct what the
-- model saw and returned at a particular prompt version.
CREATE TABLE IF NOT EXISTS article_stage_artifacts (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  stage_version TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  input_sha256 TEXT NOT NULL,
  root_input_sha256 TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  content TEXT,
  word_count INTEGER,
  model TEXT,
  vendor TEXT,
  reasoning_effort TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_stage_attempt
  ON article_stage_artifacts(article_id, stage, stage_version, attempt);
CREATE INDEX IF NOT EXISTS idx_article_stage_success
  ON article_stage_artifacts(article_id, stage, stage_version, status, created_at);

-- A batch is deliberately distinct from a published digest. It may collect
-- items across queue runs, but it is review-ready only after exactly 30 valid
-- final Russian artifacts have been added in a stable order.
CREATE TABLE IF NOT EXISTS digest_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'collecting',
  target_size INTEGER NOT NULL DEFAULT 30,
  digest_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  finalized_at TEXT,
  FOREIGN KEY (digest_id) REFERENCES digests(id)
);

CREATE TABLE IF NOT EXISTS digest_batch_items (
  batch_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  final_artifact_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (batch_id, article_id),
  UNIQUE (batch_id, position),
  FOREIGN KEY (batch_id) REFERENCES digest_batches(id),
  FOREIGN KEY (article_id) REFERENCES articles(id),
  FOREIGN KEY (final_artifact_id) REFERENCES article_stage_artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_batch_items_batch_position
  ON digest_batch_items(batch_id, position);

-- NOTE: source_posts (the FB-Syndication contract table) is intentionally NOT
-- defined here. It belongs to the optional pro cluster, which creates it
-- idempotently at startup (src/pro/db/source-posts.js migrateSourcePosts()).

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url);
CREATE INDEX IF NOT EXISTS idx_articles_digest_id ON articles(digest_id);
CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(date);
CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status);
