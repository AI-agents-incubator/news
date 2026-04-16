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
  articles_count INTEGER DEFAULT 0,
  content TEXT,
  status TEXT DEFAULT 'draft',
  generation_log TEXT,
  published_at TEXT,
  facebook_post_id TEXT,
  telegram_message_id TEXT,
  youtube_post_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url);
CREATE INDEX IF NOT EXISTS idx_articles_digest_id ON articles(digest_id);
CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(date);
CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status);
