# Telegram Personal Archive — Functional Specification

## Purpose

Full archive of all Telegram messages (sent + received) stored in Cloudflare D1, searchable by contact, keyword, date range, and chat/group.

---

## Components

```
GramJS (Fly.io shared VM)
  → Cloudflare Worker (/ingest, /search, /config endpoints)
    → Cloudflare D1 (SQLite + FTS5)
```

**Infrastructure tier:** Cloudflare Workers Paid ($5/month) — required for backfill write throughput (free tier caps at 100k row writes/day).

---

## Data Model

```sql
CREATE TABLE messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_message_id        INTEGER NOT NULL,
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
  is_deleted           INTEGER DEFAULT 0,     -- 1 if observed as deleted
  deleted_at           INTEGER,               -- Unix epoch seconds, NULL if not deleted
  indexed_at           INTEGER DEFAULT (unixepoch()),
  UNIQUE(tg_chat_id, tg_message_id)
);

CREATE TABLE chat_config (
  tg_chat_id   TEXT PRIMARY KEY,
  chat_name    TEXT,
  sync         TEXT CHECK(sync IN ('include', 'exclude')) DEFAULT 'include',
  updated_at   INTEGER DEFAULT (unixepoch())
);

CREATE TABLE global_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- Seed: INSERT INTO global_config VALUES ('sync_mode', 'all');

CREATE TABLE backfill_state (
  tg_chat_id         TEXT PRIMARY KEY,
  chat_name          TEXT,
  total_messages     INTEGER,
  fetched_messages   INTEGER DEFAULT 0,
  oldest_message_id  INTEGER,               -- offsetId anchor for next page (not numeric offset)
  status             TEXT CHECK(status IN ('pending', 'in_progress', 'complete', 'failed')) DEFAULT 'pending',
  last_error         TEXT,
  started_at         INTEGER,
  completed_at       INTEGER
);
```

### Indexes

```sql
-- Composite: covers chat timeline queries (most common pattern)
CREATE INDEX idx_chat_time ON messages(tg_chat_id, sent_at DESC);

-- Individual: for cross-chat time queries and sender lookups
CREATE INDEX idx_sent_at   ON messages(sent_at);
CREATE INDEX idx_sender_id ON messages(sender_id);

-- FTS5 virtual table for full-text search (replaces useless B-tree text index)
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  sender_username,
  sender_first_name,
  chat_name,
  content='messages',
  content_rowid='id'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, sender_username, sender_first_name, chat_name)
  VALUES (new.id, new.text, new.sender_username, new.sender_first_name, new.chat_name);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender_username, sender_first_name, chat_name)
  VALUES ('delete', old.id, old.text, old.sender_username, old.sender_first_name, old.chat_name);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender_username, sender_first_name, chat_name)
  VALUES ('delete', old.id, old.text, old.sender_username, old.sender_first_name, old.chat_name);
  INSERT INTO messages_fts(rowid, text, sender_username, sender_first_name, chat_name)
  VALUES (new.id, new.text, new.sender_username, new.sender_first_name, new.chat_name);
END;
```

> **D1/FTS5 backup caveat:** `wrangler d1 export` cannot export databases with FTS5 virtual tables. Use a scheduled Worker cron that dumps to R2 as JSON — do not rely on wrangler export for backups.

---

## Sync Modes

Stored in `global_config` as key `sync_mode`:

| Mode | Behaviour |
|------|-----------|
| `all` | Capture everything, ignore `chat_config` |
| `blacklist` | Capture everything except `exclude` entries |
| `whitelist` | Capture only `include` entries |
| `none` | Pause all capture |

Default: `all`

---

## GramJS Listener (Fly.io)

- Persistent Node.js process running in a Fly.io shared VM (~$2-4/mo)
- Deployed via `fly deploy` (Dockerfile); Fly handles restarts and health checks — no PM2 needed
- Authenticates once via phone + 2FA; session string stored as **Fly secret** (`fly secrets set GRAMJS_SESSION=...`)
- Listens to all `NewMessage` events
- On each message: evaluates sync rules → if allowed, POSTs batch to Worker `/ingest`
- Authenticates to Worker via `X-Ingest-Token` shared secret (stored as Fly secret + Cloudflare Worker secret)

### Gap Recovery on Restart

GramJS's `NewMessage` events are not replayed after a process restart — messages received during downtime are silently lost without recovery.

On every startup, before entering the live listener loop:
1. Read `last_pts` from `/data/state.json` (Fly persistent volume)
2. Call `client.invoke(new GetDifferenceRequest(...))` with the saved pts
3. Process any missed updates
4. Enter live listener loop, persisting pts on each update

This recovers gaps caused by Fly restarts or deploys.

**Fly persistent volume:** `fly volumes create tg_state --size 1` mounted at `/data`. Survives restarts and deploys — only lost if volume is explicitly deleted.

---

## Write Path

```
GramJS NewMessage event
  → evaluate sync rules (sync_mode + chat_config)
  → if allowed: buffer messages into batch (up to 100)
  → POST /ingest { messages: [...] }
  → Worker validates token, iterates batch
  → D1 db.batch() with prepared INSERT statements (UNIQUE constraint deduplicates)
```

**Batch size:** up to 100 messages per POST (D1 bound parameter limit: 100 per statement × 1 statement per message in a batch call — do not use multi-row INSERT VALUES syntax).

---

## Worker Endpoints

### Ingest (internal, token-protected)

```
POST /ingest
  Header: X-Ingest-Token: <secret>
  Body: { messages: Message[] }   -- array, 1–100 items
  Response: { inserted: N, skipped: N }
```

Request validation: reject if `abs(now - messages[0].sent_at) > 300` as a basic replay guard.

### Search

```
GET /search?q=keyword
GET /search?chat_id=xxx
GET /search?sender_username=xxx
GET /search?from=1704067200&to=1719792000   -- Unix epoch seconds
GET /search?q=keyword&chat_id=xxx&from=...&to=...

Query params:
  q             keyword (FTS5 MATCH)
  chat_id       tg_chat_id exact match
  sender_username  exact match
  from / to     Unix epoch seconds (inclusive)
  limit         default 50, max 200
  offset        default 0

Response:
{
  "results": [{ ...message row }],
  "total": N,     -- COUNT(*) for the same filters (for pagination UI)
  "limit": 50,
  "offset": 0
}
```

Search query uses FTS5 when `q` is present:

```sql
SELECT m.*
FROM messages m
JOIN messages_fts ON messages_fts.rowid = m.id
WHERE messages_fts MATCH ?
  AND (m.tg_chat_id = ? OR ? IS NULL)
  AND m.sent_at BETWEEN ? AND ?
ORDER BY m.sent_at DESC
LIMIT ? OFFSET ?;
```

### Contacts & Chats

```
GET /contacts
  -- Distinct senders from messages table
  Response: [{ sender_id, sender_username, sender_first_name, sender_last_name, message_count, last_seen }]

GET /chats
  -- Distinct chats from messages table, joined with chat_config for sync status
  Response: [{ tg_chat_id, chat_name, chat_type, message_count, last_message_at, sync_status }]
  -- sync_status: 'include' | 'exclude' | 'default' (no chat_config entry)
```

Both endpoints: no pagination (cardinality is bounded by number of distinct chats/contacts — not expected to be large).

### Config

```
GET  /config
  Response: { sync_mode: 'all'|'blacklist'|'whitelist'|'none' }

POST /config
  Body: { sync_mode: 'all'|'blacklist'|'whitelist'|'none' }

GET  /chats/config
  Response: [{ tg_chat_id, chat_name, sync, updated_at }]

POST /chats/config
  Body: { tg_chat_id, chat_name, sync: 'include'|'exclude' }

DELETE /chats/config/:tg_chat_id
  -- Removes override, chat reverts to default behaviour
```

---

## Backfill

One-time historical import using GramJS `getHistory()` per dialog.

### Design

- Uses `backfill_state` table to track progress — fully resumable
- Processes one dialog at a time (serial, not parallel)
- Paginated using `offsetId` (the `tg_message_id` of the oldest message seen in the previous batch) — **not numeric offsets**, which break if messages are deleted between calls
- Same `/ingest` batch endpoint as live listener
- Respects same sync config

### Rate limiting

- GramJS `floodSleepThreshold`: set to `300` during backfill (auto-sleep on FLOOD_WAIT up to 5 minutes)
- Batch size: 100 messages per `getHistory()` call
- Sleep 1–2 seconds between batches
- At ~30 API calls/minute (Telegram soft limit), expect 3–5 hours for a large account

### Process

```
1. Enumerate all dialogs via getDialogs()
2. For each dialog: INSERT OR IGNORE into backfill_state (status='pending')
3. Loop over pending dialogs:
   a. Set status = 'in_progress', started_at = now
   b. Fetch page using getHistory(offsetId=oldest_message_id, limit=100)
   c. POST batch to /ingest
   d. Update backfill_state.oldest_message_id, fetched_messages
   e. If page < 100 messages: set status = 'complete', completed_at = now
   f. Sleep 1s, repeat from (b)
4. On crash/restart: resume from in_progress or pending dialogs
```

---

## Auth

| Token | Used for | Location |
|-------|----------|----------|
| `X-Ingest-Token` | POST /ingest | CF Worker secret + EC2 env (Secrets Manager) |
| `X-Read-Token` (optional) | Search + config endpoints | Same, or omit if endpoints are private (Worker behind no public DNS) |

Token rotation: update CF Worker secret → update EC2 env in Secrets Manager → restart GramJS process. No deployment required on the Worker.

---

## D1 Operational Notes

- **Storage limit:** 10 GB hard ceiling per D1 database. At ~1 KB effective per message (with FTS5 overhead), capacity is ~5–10 million messages. Add a health check cron that alerts when usage crosses 7 GB.
- **Backup:** Scheduled Worker cron (daily) dumps `SELECT * FROM messages` to Cloudflare R2 as newline-delimited JSON. Do not use `wrangler d1 export` (incompatible with FTS5).
- **Write throughput:** D1 batch API handles backfill comfortably on Workers Paid tier.

---

## Out of Scope (v1)

- Media file storage (file_id reference stored only)
- UI (API only)
- Encryption at rest
- Message edit history (edit_date column present, diff tracking deferred)
- Full deletion tracking (is_deleted/deleted_at columns present, active monitoring deferred)

---

## Build Order

1. D1 schema (messages, chat_config, global_config, backfill_state, FTS5, indexes, triggers)
2. Cloudflare Worker (ingest + search + config endpoints)
3. GramJS listener on EC2 + PM2 + gap recovery on startup
4. Backfill script
5. End-to-end test
6. D1 → R2 backup cron
