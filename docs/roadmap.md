# tg-reader — Product Roadmap & Technical Proposal

## Overview

tg-reader is a **personal Telegram archive with write access**: GramJS captures every message, Cloudflare Workers + Neon PostgreSQL store and index them, and an MCP server lets Claude query and write to the archive in natural language.

Write access (outbox, actions, drafts, mass sends) is already shipped. This document proposes features that build on the existing foundation to turn tg-reader into a lightweight personal CRM.

---

## Current state (shipped)

- Full message archive (51k+ messages, all chats)
- Full-text search via PostgreSQL tsvector + GIN index
- MCP server: `search`, `chats`, `history`, `contacts`, `recent`, `stats`, `digest`, `thread`
- Write path: `send`, `draft`, `edit_message`, `delete_message`, `forward_message`
- Mass sends with per-recipient template rendering
- Outbox + actions polling (GramJS, every 30s)
- Contacts table (synced from Telegram contacts)
- Per-chat config: sync mode (include/exclude), labels
- Global sync modes: `all` / `blacklist` / `whitelist` / `none`
- Daily R2 backup

---

## Phase 1 — Intelligence on existing data (zero new ingestion)

These features require no new Telegram API calls. The data is already in Neon.

### 1.1 Unanswered filter

**What:** A smart filter that surfaces chats where the other person wrote last and you haven't replied.

**Why:** The single most useful CRM primitive. Answers "who am I ignoring right now?"

**Implementation:**

New Worker endpoint:

```
GET /chats?filter=unanswered&limit=50
```

SQL (no schema changes needed — uses `sender_id` vs `account_id`):

```sql
SELECT
  tg_chat_id,
  chat_name,
  MAX(sent_at) AS last_message_at,
  (SELECT text FROM messages m2
   WHERE m2.tg_chat_id = m.tg_chat_id
     AND m2.account_id = $1
   ORDER BY sent_at DESC LIMIT 1) AS last_text
FROM messages m
WHERE account_id = $1
GROUP BY tg_chat_id, chat_name
HAVING MAX(CASE WHEN sender_id != $1 THEN sent_at ELSE 0 END)
     > MAX(CASE WHEN sender_id = $1 THEN sent_at ELSE 0 END)
ORDER BY last_message_at DESC
LIMIT 50;
```

MCP tool addition: expose as `unanswered` tool so Claude can answer "who haven't I replied to this week?"

**Effort:** ~2 hours. No schema change, no new env vars.

---

## Phase 2 — User-added data (new tables)

### 2.1 Notes on conversations

**What:** Free-text notes attached to a chat — observations, context, things to remember.

**Why:** Makes tg-reader the single place to track everything about a relationship. Notes are queryable by Claude via FTS.

**Schema:**

```sql
CREATE TABLE notes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  TEXT    NOT NULL,
  tg_chat_id  TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
  created_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX idx_notes_chat ON notes (account_id, tg_chat_id, created_at DESC);
CREATE INDEX idx_notes_fts  ON notes USING GIN (search_vector);
```

**API:**

```
POST /notes          { tg_chat_id, body }  → { id }
GET  /notes?chat_id= → [{ id, body, created_at }]
PUT  /notes/:id      { body }
DELETE /notes/:id
```

MCP tool addition: `add_note`, `get_notes` — Claude can store and retrieve notes mid-conversation.

**Effort:** ~3 hours.

---

### 2.2 Pipeline status & labels

**What:** Per-chat status (`active`, `follow_up`, `waiting`, `done`) and free-form labels (`investor`, `client`, `friend`).

**Why:** Turns the archive into a trackable pipeline. Filter by status to get your daily priority list.

**Schema:**

Add columns to `chat_config` (already exists):

```sql
ALTER TABLE chat_config ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'follow_up', 'waiting', 'done', 'archived'));
ALTER TABLE chat_config ADD COLUMN IF NOT EXISTS labels TEXT DEFAULT '[]'; -- JSON array of strings
ALTER TABLE chat_config ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0; -- 0=normal, 1=high
```

**API:**

```
PATCH /chats/:chat_id   { status?, labels?, priority? }
GET   /chats?status=follow_up
GET   /chats?label=investor
```

MCP tool addition: `set_status`, `set_label` — Claude can update pipeline state when you say "mark the Alpha deal as waiting".

**Effort:** ~2 hours. `ALTER TABLE IF NOT EXISTS` is non-destructive.

---

### 2.3 Reminders

**What:** Time-based follow-up flags: "remind me to follow up with X in 3 days."

**Why:** Closes the loop. An archive without reminders is a graveyard — you find old threads but can't act on them.

**Schema:**

```sql
CREATE TABLE reminders (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  TEXT    NOT NULL,
  tg_chat_id  TEXT    NOT NULL,
  note        TEXT,
  remind_at   BIGINT  NOT NULL, -- Unix epoch seconds
  fired       SMALLINT NOT NULL DEFAULT 0,
  created_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX idx_reminders_due ON reminders (account_id, fired, remind_at);
```

**API:**

```
POST /reminders      { tg_chat_id, remind_at, note }  → { id }
GET  /reminders/due  → reminders where remind_at <= now AND fired = 0
POST /reminders/:id/dismiss
```

**Delivery options (pick one):**

| Option | Mechanism | Effort |
|--------|-----------|--------|
| Telegram DM | Use existing outbox: send to Saved Messages | Low — outbox already works |
| Webhook | Worker cron hits a user-supplied `WEBHOOK_URL` | Low |
| MCP poll | Claude checks `/reminders/due` at session start | Zero extra |

Cron trigger (already supported by Cloudflare Workers):

```toml
# wrangler.toml
[[triggers.crons]]
crons = ["*/15 * * * *"]  # every 15 minutes
```

**Effort:** ~3 hours (schema + API + cron delivery via outbox).

---

## Implementation order

| Phase | Feature | Effort | Value |
|-------|---------|--------|-------|
| 1 | Unanswered filter | 2h | High |
| 2a | Notes | 3h | High |
| 2b | Pipeline status | 2h | Medium |
| 2c | Reminders | 3h | High |

**Recommended start:** Unanswered filter — pure SQL, no schema migration, immediate value.

---

## What this becomes

After all phases, tg-reader is:

- A **complete personal Telegram CRM** with full message history going back to whenever you started
- AI-native: Claude can search, summarise, update pipeline status, set reminders, and draft replies in natural language
- **Fully self-hosted** on Cloudflare Workers + Neon at minimal cost
- No per-seat pricing, no vendor lock-in

The key differentiator: tg-reader has **years of history** and full message content from day one. Most CRM tools start from when you install them.
