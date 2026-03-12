-- TG Reader — D1 Schema
-- Single source of truth. Apply with:
--   wrangler d1 execute tg-archive --file=schema.sql           (production)
--   wrangler d1 execute tg-archive --local --file=schema.sql   (local dev)

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id           TEXT NOT NULL DEFAULT 'primary',  -- which TG account captured this
  tg_message_id        TEXT NOT NULL,           -- TEXT: Telegram message IDs may exceed 32-bit INTEGER precision
  tg_chat_id           TEXT NOT NULL,         -- stored as TEXT, Telegram IDs are 64-bit
  chat_name            TEXT,
  chat_type            TEXT CHECK(chat_type IN ('user', 'group', 'supergroup', 'channel', 'bot')),
  sender_id            TEXT,
  sender_username      TEXT,
  sender_first_name    TEXT,
  sender_last_name     TEXT,
  direction            TEXT CHECK(direction IN ('in', 'out')),
  message_type         TEXT,                  -- text, sticker, poll, location, contact, dice, etc.
  text                 TEXT,
  media_type           TEXT,                  -- photo, video, document, voice, audio, sticker, etc.
  media_file_id        TEXT,                  -- reference only, no binary stored
  reply_to_message_id  INTEGER,
  forwarded_from_id    TEXT,
  forwarded_from_name  TEXT,
  sent_at              INTEGER NOT NULL,      -- Unix epoch seconds (Telegram native format)
  edit_date            INTEGER,               -- Unix epoch seconds, NULL if never edited
  original_text        TEXT,                  -- text before first edit; NULL if never edited
  is_deleted           INTEGER DEFAULT 0,     -- 1 if observed as deleted
  deleted_at           INTEGER,               -- Unix epoch seconds, NULL if not deleted
  indexed_at           INTEGER DEFAULT (unixepoch()),
  UNIQUE(account_id, tg_chat_id, tg_message_id)
);

CREATE TABLE chat_config (
  account_id   TEXT NOT NULL DEFAULT 'primary',
  tg_chat_id   TEXT NOT NULL,
  chat_name    TEXT,
  sync         TEXT CHECK(sync IN ('include', 'exclude')) DEFAULT 'include',
  updated_at   INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, tg_chat_id)
);

CREATE TABLE global_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE contacts (
  account_id   TEXT NOT NULL DEFAULT 'primary',
  tg_user_id   TEXT NOT NULL,               -- stored as TEXT, 64-bit
  phone        TEXT,
  username     TEXT,
  first_name   TEXT,
  last_name    TEXT,
  is_mutual    INTEGER DEFAULT 0,           -- 1 if they have you saved too
  is_bot       INTEGER DEFAULT 0,
  updated_at   INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, tg_user_id)
);

CREATE TABLE backfill_state (
  account_id         TEXT NOT NULL DEFAULT 'primary',
  tg_chat_id         TEXT NOT NULL,
  chat_name          TEXT,
  total_messages     INTEGER,
  fetched_messages   INTEGER DEFAULT 0,
  oldest_message_id  INTEGER,               -- offsetId anchor for next page (not numeric offset)
  status             TEXT CHECK(status IN ('pending', 'in_progress', 'complete', 'failed')) DEFAULT 'pending',
  last_error         TEXT,
  started_at         INTEGER,
  completed_at       INTEGER,
  PRIMARY KEY (account_id, tg_chat_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Composite: covers chat timeline queries (most common pattern)
CREATE INDEX idx_chat_time ON messages(account_id, tg_chat_id, sent_at DESC);

-- Individual: for cross-chat time queries and sender lookups
CREATE INDEX idx_sent_at   ON messages(account_id, sent_at);
CREATE INDEX idx_sender_id ON messages(account_id, sender_id);

-- Covers keyset pagination ORDER BY (sent_at, id)
CREATE INDEX idx_account_sent_id ON messages(account_id, sent_at DESC, id DESC);

-- Covers thread reconstruction queries (reply chains)
CREATE INDEX idx_reply_to ON messages(account_id, tg_chat_id, reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE INDEX idx_contacts_username ON contacts(account_id, username);

-- ---------------------------------------------------------------------------
-- FTS5 virtual table
-- ---------------------------------------------------------------------------

-- Full-text search (replaces useless B-tree text index)
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  sender_username,
  sender_first_name,
  chat_name,
  content='messages',
  content_rowid='id'
);

-- ---------------------------------------------------------------------------
-- FTS5 sync triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, sender_username, sender_first_name, chat_name)
  VALUES (new.id, new.text, new.sender_username, new.sender_first_name, new.chat_name);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender_username, sender_first_name, chat_name)
  VALUES ('delete', old.id, old.text, old.sender_username, old.sender_first_name, old.chat_name);
END;

-- Only re-index when FTS-indexed columns actually change — avoids phantom FTS rows on
-- is_deleted / indexed_at updates which fire on every upsert.
CREATE TRIGGER messages_au AFTER UPDATE ON messages
WHEN OLD.text IS NOT NEW.text
  OR OLD.sender_username IS NOT NEW.sender_username
  OR OLD.sender_first_name IS NOT NEW.sender_first_name
  OR OLD.chat_name IS NOT NEW.chat_name
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender_username, sender_first_name, chat_name)
  VALUES ('delete', old.id, old.text, old.sender_username, old.sender_first_name, old.chat_name);
  INSERT INTO messages_fts(rowid, text, sender_username, sender_first_name, chat_name)
  VALUES (new.id, new.text, new.sender_username, new.sender_first_name, new.chat_name);
END;

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO global_config VALUES ('sync_mode', 'all');
