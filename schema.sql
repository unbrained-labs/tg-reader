-- TG Reader — PostgreSQL Schema
-- Single source of truth. Apply with:
--   psql $DATABASE_URL -f schema.sql

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id           TEXT NOT NULL DEFAULT 'primary',  -- which TG account captured this
  tg_message_id        TEXT NOT NULL,           -- TEXT: Telegram message IDs may exceed 32-bit INTEGER precision
  tg_chat_id           TEXT NOT NULL,           -- stored as TEXT, Telegram IDs are 64-bit
  chat_name            TEXT,
  chat_type            TEXT CHECK(chat_type IN ('user', 'group', 'supergroup', 'channel', 'bot')),
  sender_id            TEXT,
  sender_username      TEXT,
  sender_first_name    TEXT,
  sender_last_name     TEXT,
  direction            TEXT CHECK(direction IN ('in', 'out')),
  message_type         TEXT,                    -- text, sticker, poll, location, contact, dice, etc.
  text                 TEXT,
  media_type           TEXT,                    -- photo, video, document, voice, audio, sticker, etc.
  media_file_id        TEXT,                    -- reference only, no binary stored
  reply_to_message_id  BIGINT,
  forwarded_from_id    TEXT,
  forwarded_from_name  TEXT,
  sent_at              BIGINT NOT NULL,         -- Unix epoch seconds (Telegram native format)
  edit_date            BIGINT,                  -- Unix epoch seconds, NULL if never edited
  original_text        TEXT,                    -- text before first edit; NULL if never edited
  is_deleted           SMALLINT NOT NULL DEFAULT 0,   -- 1 if observed as deleted
  deleted_at           BIGINT,                  -- Unix epoch seconds, NULL if not deleted
  indexed_at           BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  search_vector        tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      COALESCE(text, '') || ' ' ||
      COALESCE(sender_username, '') || ' ' ||
      COALESCE(sender_first_name, '') || ' ' ||
      COALESCE(chat_name, '')
    )
  ) STORED,
  UNIQUE(account_id, tg_chat_id, tg_message_id)
);

CREATE TABLE chat_config (
  account_id   TEXT NOT NULL DEFAULT 'primary',
  tg_chat_id   TEXT NOT NULL,
  chat_name    TEXT,
  sync         TEXT CHECK(sync IN ('include', 'exclude')) DEFAULT 'include',
  updated_at   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
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
  is_mutual    SMALLINT NOT NULL DEFAULT 0, -- 1 if they have you saved too
  is_bot       SMALLINT NOT NULL DEFAULT 0,
  updated_at   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  PRIMARY KEY (account_id, tg_user_id)
);

CREATE TABLE backfill_state (
  account_id         TEXT NOT NULL DEFAULT 'primary',
  tg_chat_id         TEXT NOT NULL,
  chat_name          TEXT,
  total_messages     BIGINT,
  fetched_messages   BIGINT NOT NULL DEFAULT 0,
  oldest_message_id  BIGINT,                -- offsetId anchor for next page (not numeric offset)
  status             TEXT CHECK(status IN ('pending', 'in_progress', 'complete', 'failed')) DEFAULT 'pending',
  last_error         TEXT,
  started_at         BIGINT,
  completed_at       BIGINT,
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

-- Full-text search (replaces FTS5 virtual table)
CREATE INDEX idx_messages_fts ON messages USING GIN (search_vector);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

INSERT INTO global_config (key, value) VALUES ('sync_mode', 'all')
  ON CONFLICT (key) DO NOTHING;
