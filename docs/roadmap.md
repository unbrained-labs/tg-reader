# tg-reader — Product Roadmap & Technical Proposal

## Overview

tg-reader is currently a **read-only personal Telegram archive**: GramJS captures every message, Cloudflare Workers + D1 store and index them, and an MCP server lets Claude query the archive in natural language.

This document proposes five features that turn it into a lightweight personal CRM — plus optional write access to Telegram — without changing the core architecture.

---

## Phase 1 — Intelligence on existing data (zero new ingestion)

These features require no new Telegram API calls. The data is already in D1.

### 1.1 Unanswered filter

> AI features (summaries, smart search, etc.) are tracked separately — see the `ai` feature branch.

**What:** A smart filter that surfaces chats where the other person wrote last and you haven't replied.

**Why:** The single most useful CRM primitive. Answers "who am I ignoring right now?"

**Implementation:**

New Worker endpoint:

```
GET /chats?filter=unanswered&limit=50
```

SQL (no schema changes):

```sql
SELECT
  tg_chat_id,
  chat_name,
  MAX(sent_at) AS last_message_at,
  (SELECT text FROM messages m2
   WHERE m2.tg_chat_id = m.tg_chat_id
   ORDER BY sent_at DESC LIMIT 1) AS last_text
FROM messages m
GROUP BY tg_chat_id
HAVING MAX(CASE WHEN direction = 'in' THEN sent_at ELSE 0 END)
     > MAX(CASE WHEN direction = 'out' THEN sent_at ELSE 0 END)
ORDER BY last_message_at DESC
LIMIT ?;
```

MCP tool addition: expose as `unanswered` tool so Claude can answer "who haven't I replied to this week?"

**Effort:** ~2 hours. No schema change, no new env vars.

---

## Phase 2 — User-added data (new D1 tables)

### 2.1 Notes on conversations

**What:** Free-text notes attached to a chat — observations, context, things to remember.

**Why:** Makes tg-reader the single place to track everything about a relationship. Notes are queryable by Claude via FTS5.

**Schema:**

```sql
CREATE TABLE notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_chat_id  TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_notes_chat ON notes (tg_chat_id, created_at DESC);

-- Include notes in FTS so Claude can search across messages AND notes
INSERT INTO messages_fts (messages_fts) VALUES ('rebuild'); -- after adding notes_fts
CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='id');
```

**API:**

```
POST /notes          { tg_chat_id, body }  → { id }
GET  /notes?chat_id= → [{ id, body, created_at }]
PUT  /notes/:id      { body }
DELETE /notes/:id
```

MCP tool addition: `add_note`, `get_notes` — Claude can store and retrieve notes mid-conversation.

**Effort:** ~3 hours including FTS integration.

---

### 2.2 Pipeline status & labels

**What:** Per-chat status (`active`, `follow_up`, `waiting`, `done`) and free-form labels (`investor`, `client`, `friend`).

**Why:** Turns the archive into a trackable pipeline. Filter by status to get your daily priority list.

**Schema:**

Add columns to `chat_config` (already exists):

```sql
ALTER TABLE chat_config ADD COLUMN status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'follow_up', 'waiting', 'done', 'archived'));
ALTER TABLE chat_config ADD COLUMN labels TEXT DEFAULT '[]'; -- JSON array of strings
ALTER TABLE chat_config ADD COLUMN priority INTEGER DEFAULT 0; -- 0=normal, 1=high
```

**API:**

```
PATCH /chats/:chat_id   { status?, labels?, priority? }
GET   /chats?status=follow_up
GET   /chats?label=investor
```

MCP tool addition: `set_status`, `set_label` — Claude can update pipeline state when you say "mark the Alpha deal as waiting".

**Effort:** ~2 hours. ALTER TABLE is non-destructive.

---

### 2.3 Reminders

**What:** Time-based follow-up flags: "remind me to follow up with X in 3 days."

**Why:** Closes the loop. An archive without reminders is a graveyard — you find old threads but can't act on them.

**Schema:**

```sql
CREATE TABLE reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_chat_id  TEXT    NOT NULL,
  note        TEXT,
  remind_at   INTEGER NOT NULL, -- Unix epoch seconds
  fired       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_reminders_due ON reminders (fired, remind_at);
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
| Webhook | Worker cron hits a user-supplied `WEBHOOK_URL` | Low |
| Telegram message | Write API (Phase 3) sends yourself a DM | Medium |
| MCP poll | Claude checks `/reminders/due` at session start | Zero extra |

Cron trigger (already supported by Cloudflare Workers):

```toml
# wrangler.toml
[[triggers.crons]]
crons = ["*/15 * * * *"]  # every 15 minutes
```

```ts
// worker/src/cron.ts
export async function handleCron(env: Env): Promise<void> {
  const due = await getDueReminders(env.DB);
  for (const r of due) {
    await fireReminder(r, env);   // webhook or Telegram DM
    await markFired(r.id, env.DB);
  }
}
```

**Effort:** ~4 hours including cron setup and webhook delivery.

---

## Phase 3 — Optional write access to Telegram

**What:** Allow tg-reader to *send* messages on your behalf — for reminders, quick replies, message templates.

**Why requested:** Reminders delivered as Telegram DMs are far more actionable than webhooks. Templates eliminate repetitive copy-paste.

### Architecture

Write access is **opt-in** and handled exclusively by the GramJS layer — never by the Worker directly. The Worker queues outbound actions; GramJS executes them.

```
Worker ──POST /outbox──→ D1 outbox table
GramJS ──polls /outbox──→ client.sendMessage() / client.forwardMessages()
```

This keeps Telegram credentials out of the Worker (which runs on Cloudflare's edge, outside your network).

### Outbox schema

```sql
CREATE TABLE outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT    NOT NULL,  -- 'send_message' | 'forward' | 'send_self'
  payload     TEXT    NOT NULL,  -- JSON: { to, text } or { from_chat, msg_ids, to }
  status      TEXT    NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at     INTEGER
);
```

### Worker outbox API

```
POST /outbox   { action, payload }  → { id }   (authenticated with X-Ingest-Token)
GET  /outbox/pending                → [{ id, action, payload }]
POST /outbox/:id/ack   { status, error? }
```

### GramJS outbox poller

```ts
// Added to listener.ts startup
setInterval(async () => {
  const res = await fetch(`${WORKER_URL}/outbox/pending`, { headers });
  const jobs = await res.json() as OutboxJob[];
  for (const job of jobs) {
    try {
      await executeOutboxJob(client, job);
      await ack(job.id, 'sent');
    } catch (err) {
      await ack(job.id, 'failed', String(err));
    }
    await sleep(Math.random() * 1000 + 500); // anti-ban between sends
  }
}, 30_000); // poll every 30s
```

### Supported actions (v1)

| Action | Payload | Use case |
|--------|---------|----------|
| `send_self` | `{ text }` | Reminder DMs to Saved Messages |
| `send_message` | `{ to: tg_chat_id, text }` | Quick reply from Claude/MCP |
| `forward` | `{ from_chat, msg_ids: number[], to }` | Forward messages between chats |

### MCP tools (with write)

- `reply` — Claude drafts a reply, you approve, it sends
- `send_reminder` — Claude schedules a Telegram DM to Saved Messages
- `use_template` — fill a template and send to a contact

### Anti-ban considerations for write

- Never send more than 1 message/second to any single peer
- Randomize inter-send delay: `500ms + random(0, 1000ms)`
- `send_self` (Saved Messages) has no rate limit — safest for reminders
- Respect `floodSleepThreshold: 300` already set on the client
- **Never** expose `send_message` via a public API endpoint — only via authenticated MCP or outbox queue

---

## Implementation order

| Phase | Feature | Effort | Value |
|-------|---------|--------|-------|
| 1 | Unanswered filter | 2h | High |
| 2a | Notes | 3h | High |
| 2b | Pipeline status | 2h | Medium |
| 2c | Reminders (webhook) | 4h | High |
| 3 | Write access + outbox | 8h | Medium |
| 3b | Reminders via Telegram DM | 2h | High (needs Phase 3) |
| — | AI integration | separate branch | — |

**Recommended start:** Unanswered filter — pure SQL, no schema migration, immediate value.

---

## What this becomes

After all phases, tg-reader is:

- A **complete personal Telegram CRM** with full message history going back to whenever you started
- AI-native: Claude can search, summarise, update pipeline status, set reminders, and draft replies in natural language
- **$0 marginal cost** at personal scale (Cloudflare Workers free tier + occasional AI calls)
- No per-seat pricing, no vendor lock-in, fully self-hosted

The key differentiator vs DISE: tg-reader has **years of history** and full message content. DISE starts from when you install it. For anyone using Telegram as their primary business communication channel, historical context is the whole game.
