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
  account_id TEXT NOT NULL DEFAULT 'global',
  key        TEXT NOT NULL,
  value      TEXT,
  PRIMARY KEY (account_id, key)
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

INSERT INTO global_config (account_id, key, value) VALUES ('global', 'sync_mode', 'all')
  ON CONFLICT (account_id, key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RBAC — roles, agent tokens, and audit log
-- ---------------------------------------------------------------------------

-- Roles are account-agnostic templates — reusable across any number of accounts.
-- The account binding comes from token_account_roles, not from the role itself.
CREATE TABLE IF NOT EXISTS roles (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,   -- "work-reader", "dm-assistant", "full"

  -- Read scope
  read_mode        TEXT NOT NULL DEFAULT 'all',  -- 'all' | 'whitelist' | 'blacklist'
  read_labels      TEXT,    -- JSON array e.g. ["work","clients"], NULL = no filter from this field
  read_chat_ids    TEXT,    -- JSON array of tg_chat_ids, NULL = no filter from this field

  -- Write permissions (all off by default)
  can_send         SMALLINT NOT NULL DEFAULT 0,
  can_edit         SMALLINT NOT NULL DEFAULT 0,
  can_delete       SMALLINT NOT NULL DEFAULT 0,
  can_forward      SMALLINT NOT NULL DEFAULT 0,

  -- Write scope (NULL = inherit read scope)
  write_chat_types TEXT,   -- JSON array: ["user","group","supergroup","channel"]
  write_labels     TEXT,   -- JSON array of labels
  write_chat_ids   TEXT    -- JSON array of tg_chat_ids
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the raw token, never plaintext
  label        TEXT,                  -- "work claude", "read-only scout"
  expires_at   BIGINT,                -- Unix epoch seconds, NULL = no expiry
  last_used_at BIGINT,                -- NULL until first use; updated at most once per day
  created_at   BIGINT NOT NULL
);

-- Many-to-many: one token can access multiple accounts, each with its own role.
-- Single-account tokens just have one row here.
CREATE TABLE IF NOT EXISTS token_account_roles (
  token_id    BIGINT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL,
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (token_id, account_id)
);

-- Audit log for write operations (send / edit / delete / forward).
-- Retention configurable via global_config key 'audit_log_retention_days' (default 90).
-- Read operations are NOT logged — volume is tiny even for heavy write usage.
CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id       BIGINT REFERENCES agent_tokens(id) ON DELETE SET NULL,
  account_id     TEXT NOT NULL,
  action         TEXT NOT NULL,    -- 'send' | 'edit' | 'delete' | 'forward'
  target_chat_id TEXT,
  detail         TEXT,             -- JSON: message_id, action type — no message content
  created_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_token   ON audit_log (token_id);

-- ---------------------------------------------------------------------------
-- Observer jobs — AI agent cron tasks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     TEXT NOT NULL,
  name           TEXT NOT NULL,

  enabled        SMALLINT NOT NULL DEFAULT 1,

  -- Trigger: schedule, condition, or both
  schedule       TEXT,           -- cron expression e.g. "0 8 * * *" (optional)
  trigger_type   TEXT,           -- 'new_message' | 'keyword' | 'unanswered' (optional)
  trigger_config TEXT,           -- JSON, depends on trigger_type

  -- Model (BYOM — Bring Your Own Model)
  model_config   TEXT NOT NULL,  -- JSON: { provider, model, api_key_ref, endpoint? }

  -- Task
  task_prompt    TEXT NOT NULL,  -- instructions for the agent; supports {variables}

  -- Access (RBAC) — null token = job is disabled until a token is assigned
  token_id       BIGINT REFERENCES agent_tokens(id) ON DELETE SET NULL,

  -- State
  last_run_at    BIGINT,
  cooldown_secs  INTEGER NOT NULL DEFAULT 3600,  -- min gap between runs, prevents spam

  created_at     BIGINT NOT NULL,

  UNIQUE (account_id, name)
);

-- ---------------------------------------------------------------------------
-- Additional seed data
-- ---------------------------------------------------------------------------

INSERT INTO global_config (account_id, key, value) VALUES ('global', 'audit_log_retention_days', '90')
  ON CONFLICT (account_id, key) DO NOTHING;

-- Mass send safety limits (configurable via global_config)
INSERT INTO global_config (account_id, key, value) VALUES ('global', 'mass_send_max_recipients', '25')
  ON CONFLICT (account_id, key) DO NOTHING;

INSERT INTO global_config (account_id, key, value) VALUES ('global', 'mass_send_contacts_only', '1')
  ON CONFLICT (account_id, key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- AI Chat Insights — generated by observer jobs, opt-in
-- ---------------------------------------------------------------------------

-- data JSONB shape:
-- {
--   "tone": "warm",                        -- warm | neutral | professional | tense
--   "tone_trend": "improving",             -- improving | stable | declining (optional)
--   "topics": ["work", "travel"],
--   "relationship_arc": "Started as professional contact...",  -- optional
--   "initiated_by": "balanced",            -- me | them | balanced
--   "avg_response_time_hrs": 1.8,          -- optional
--   "unresolved_threads": ["They asked about X with no reply"],  -- optional
--   "last_active_days_ago": 2,             -- optional
--   "summary": "Close collaborator with frequent check-ins.",
--   "follow_up": "You haven't replied to their message from 2 days ago."  -- optional
-- }

CREATE TABLE IF NOT EXISTS chat_insights (
  account_id       TEXT NOT NULL,
  tg_chat_id       TEXT NOT NULL,
  generated_at     BIGINT NOT NULL,         -- unix epoch when insight was generated
  last_message_at  BIGINT NOT NULL,         -- MAX(sent_at) of messages used (watermark for delta check)
  model            TEXT NOT NULL,           -- e.g. "claude-haiku-4-5"
  insight_type     TEXT NOT NULL DEFAULT 'full',
  data             JSONB NOT NULL,          -- see shape above
  PRIMARY KEY (account_id, tg_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_insights_account ON chat_insights (account_id);
