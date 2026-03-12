-- TG Reader — PostgreSQL Schema
-- Single source of truth. Apply with:
--   psql $DATABASE_URL -f schema.sql
--
-- Safe to re-run against an existing database — all statements use IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages (
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

CREATE TABLE IF NOT EXISTS chat_config (
  account_id   TEXT NOT NULL DEFAULT 'primary',
  tg_chat_id   TEXT NOT NULL,
  chat_name    TEXT,
  sync         TEXT CHECK(sync IN ('include', 'exclude')) DEFAULT 'include',
  label        TEXT,   -- freeform tag e.g. 'work', 'client', 'team', 'personal'
  updated_at   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  PRIMARY KEY (account_id, tg_chat_id)
);

CREATE TABLE IF NOT EXISTS global_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
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

CREATE TABLE IF NOT EXISTS backfill_state (
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
CREATE INDEX IF NOT EXISTS idx_chat_time ON messages(account_id, tg_chat_id, sent_at DESC);

-- Individual: for cross-chat time queries and sender lookups
CREATE INDEX IF NOT EXISTS idx_sent_at   ON messages(account_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_sender_id ON messages(account_id, sender_id);

-- Covers keyset pagination ORDER BY (sent_at, id)
CREATE INDEX IF NOT EXISTS idx_account_sent_id ON messages(account_id, sent_at DESC, id DESC);

-- Covers thread reconstruction queries (reply chains)
CREATE INDEX IF NOT EXISTS idx_reply_to ON messages(account_id, tg_chat_id, reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_username ON contacts(account_id, username);

-- Full-text search (replaces FTS5 virtual table)
CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN (search_vector);

-- ---------------------------------------------------------------------------
-- Outbox (drafts, scheduled sends, replies, mass sends)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outbox (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          TEXT NOT NULL DEFAULT 'primary',
  -- single-send target (NULL when recipients rows exist for mass sends)
  tg_chat_id          TEXT,
  reply_to_message_id BIGINT,
  -- message text; may contain {user}, {first_name}, {last_name}, {username} placeholders
  text                TEXT NOT NULL,
  -- draft      → not yet queued
  -- scheduled  → queued but wait until scheduled_at
  -- pending    → ready for immediate pickup by GramJS
  -- sending    → GramJS has claimed it (prevents double-send)
  -- sent       → delivered (single send)
  -- failed     → delivery failed (single send or entire mass send)
  -- partial    → mass send where at least one recipient failed
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK(status IN ('draft','scheduled','pending','sending','sent','failed','partial')),
  scheduled_at        BIGINT,   -- unix epoch seconds; NULL = send immediately when triggered
  error               TEXT,
  created_at          BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at          BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  sent_at             BIGINT    -- unix epoch seconds when actually sent (mass send: when started)
);

-- Per-recipient rows for mass sends; absent = single-chat send
CREATE TABLE IF NOT EXISTS outbox_recipients (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id   BIGINT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  tg_chat_id  TEXT NOT NULL,
  first_name  TEXT,
  username    TEXT,
  last_name   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','sent','failed')),
  sent_at     BIGINT,
  error       TEXT
);

-- GramJS polls for pending/due-scheduled items
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(account_id, status, scheduled_at)
  WHERE status IN ('pending','scheduled','sending');

CREATE INDEX IF NOT EXISTS idx_outbox_recipients_pending ON outbox_recipients(outbox_id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Pending actions (edit / delete / forward on already-sent messages)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pending_actions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    TEXT NOT NULL DEFAULT 'primary',
  action        TEXT NOT NULL CHECK(action IN ('edit', 'delete', 'forward')),
  tg_chat_id    TEXT NOT NULL,   -- source chat
  tg_message_id TEXT NOT NULL,   -- source message ID (string — 64-bit)
  text          TEXT,            -- edit only: new message text
  to_chat_id    TEXT,            -- forward only: destination chat ID
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending', 'done', 'failed')),
  error         TEXT,
  created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_due ON pending_actions(account_id, status)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

INSERT INTO global_config (key, value) VALUES ('sync_mode', 'all')
  ON CONFLICT (key) DO NOTHING;
