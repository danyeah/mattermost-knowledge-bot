PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS channels (
  mm_channel_id          TEXT PRIMARY KEY,
  mm_channel_name        TEXT NOT NULL,
  outline_collection_id  TEXT NOT NULL UNIQUE,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_channel_id          TEXT NOT NULL REFERENCES channels(mm_channel_id) ON DELETE CASCADE,
  topic_slug             TEXT NOT NULL,
  topic_display_name     TEXT NOT NULL,
  outline_document_id    TEXT NOT NULL UNIQUE,
  summary                TEXT,
  last_indexed_at        TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  last_updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mm_channel_id, topic_slug)
);

CREATE INDEX IF NOT EXISTS idx_topics_channel ON topics(mm_channel_id);

CREATE TABLE IF NOT EXISTS saves (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_channel_id            TEXT NOT NULL,
  mm_post_id               TEXT NOT NULL UNIQUE,
  mm_root_post_id          TEXT NOT NULL,
  topic_id                 INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  triggered_by_user_id     TEXT NOT NULL,
  triggered_by_username    TEXT NOT NULL,
  outline_revision_before  TEXT,
  outline_revision_after   TEXT,
  status                   TEXT NOT NULL CHECK (status IN ('success','failed','pending_confirmation','cancelled')),
  error_message            TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saves_channel ON saves(mm_channel_id);
CREATE INDEX IF NOT EXISTS idx_saves_status ON saves(status);

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_channel_id         TEXT NOT NULL,
  mm_thread_root_id     TEXT NOT NULL,
  mm_trigger_post_id    TEXT NOT NULL UNIQUE,
  bot_reply_post_id     TEXT NOT NULL,
  triggered_by_user_id  TEXT NOT NULL,
  proposed_topic_slug   TEXT NOT NULL,
  proposed_topic_name   TEXT NOT NULL,
  alternative_topics    TEXT,
  payload_json          TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_thread ON pending_confirmations(mm_thread_root_id);
CREATE INDEX IF NOT EXISTS idx_pending_bot_reply ON pending_confirmations(bot_reply_post_id);
