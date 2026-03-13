# Telegram Personal Archive — Functional Specification

## Purpose

Full archive of all Telegram messages (sent + received) stored in Neon PostgreSQL, searchable by contact, keyword, date range, and chat/group. Supports writing: replies, drafts, scheduled sends, mass sends, edit/delete/forward.

---

## Components

```
GramJS (Fly.io shared VM)
  → Cloudflare Worker (REST API + MCP server)
    → Neon PostgreSQL (serverless HTTP)
    → Cloudflare R2 (daily backup)
```

**Infrastructure tier:** Cloudflare Workers Paid ($5/month). Neon serverless PostgreSQL ($0–19/month).

---

## Data Model

See `schema.sql` for the authoritative PostgreSQL schema. Key tables:

### messages
Primary archive table. `account_id` scopes all queries for multi-account support.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT IDENTITY | internal PK |
| `account_id` | TEXT | Telegram user ID of the archive owner |
| `tg_message_id` | TEXT | Telegram message ID — always TEXT (64-bit safe) |
| `tg_chat_id` | TEXT | always TEXT — Telegram IDs are 64-bit |
| `chat_name` | TEXT | display name at ingest time |
| `chat_type` | TEXT | `'user'`, `'group'`, `'supergroup'`, `'channel'` |
| `sender_id` | TEXT | always TEXT; equals `account_id` for outgoing messages |
| `sender_username` | TEXT | nullable |
| `sent_at` | BIGINT | Unix epoch seconds — Telegram's native format |
| `edit_date` | BIGINT | Unix epoch seconds, NULL if never edited |
| `original_text` | TEXT | pre-edit text, NULL if never edited |
| `is_deleted` | SMALLINT | 0 or 1 |
| `search_vector` | tsvector | generated column, GIN indexed |

> Outgoing messages are identified by `sender_id = account_id`. There is no `direction` column.

### chat_config
Per-chat sync overrides and labels.

| Column | Notes |
|--------|-------|
| `sync` | `'include'` or `'exclude'` |
| `label` | freeform tag e.g. `'work'`, `'personal'` |

### outbox
Write queue — drafts, scheduled sends, single sends, mass sends.

| Status | Meaning |
|--------|---------|
| `draft` | not yet queued |
| `scheduled` | queued, wait until `scheduled_at` |
| `pending` | ready for immediate pickup |
| `sending` | GramJS has claimed it |
| `sent` | delivered |
| `failed` | delivery failed |
| `partial` | mass send with some failures |

### outbox_recipients
Per-recipient rows for mass sends. Each has its own `status` (`pending` → `sent`/`failed`).

### pending_actions
Edit / delete / forward on already-sent messages. Status: `pending` → `done`/`failed`.

### contacts, backfill_state, global_config
See `schema.sql`.

---

## Sync Modes

Stored in `global_config` as key `sync_mode`. Supports per-account overrides: row with `account_id = <id>` takes precedence over `account_id = 'global'`.

| Mode | Behaviour |
|------|-----------|
| `all` | Capture everything, ignore `chat_config` |
| `blacklist` | Capture everything except `exclude` entries |
| `whitelist` | Capture only `include` entries |
| `none` | Pause all capture |

Default: `all`

---

## GramJS Listener (Fly.io)

- Persistent Node.js process in a Fly.io shared VM
- Authenticates once; session string stored as Fly secret
- Handles `NewMessage`, `EditedMessage`, `DeletedMessage` events
- **Outbox polling**: every 30s calls `GET /outbox/due` → sends claimed items → `POST /outbox/:id/ack`
- **Actions polling**: every 30s calls `GET /actions/pending` → executes edit/delete/forward → `POST /actions/:id/ack`

### Gap Recovery

On every startup:
1. Read `last_pts` from `/data/state.json` (Fly persistent volume)
2. Call `getDifference()` with saved pts
3. Process missed updates
4. Enter live listener loop, persisting pts every 60s

### Template rendering (mass send)

Placeholders replaced per recipient: `{user}` (first name → @username → "there"), `{first_name}`, `{last_name}`, `{username}`.

---

## Write Path (outbox)

```
POST /outbox  →  insert row (status=draft|pending|scheduled)
                  ↓
GET /outbox/due (GramJS polls every 30s)
  → atomic CTE: reset stuck 'sending' items, claim due items
  → return items with status='sending'
                  ↓
GramJS sends via Telegram API
  → POST /outbox/:id/ack  { status: sent|failed|partial }
```

For mass sends, `outbox_recipients` rows track per-chat status. Failed recipients are reset and retried on stuck-item recovery.

---

## Worker Endpoints

### Read

| Endpoint | Description |
|----------|-------------|
| `GET /search` | Full-text search — `q`, `chat_id`, `sender_username`, `from`, `to`, `limit`, `before_id`, `before_sent_at` |
| `GET /chats` | All chats — `name` filter, `label` filter |
| `GET /contacts` | Contacts with message counts — `search` filter |
| `GET /stats` | Archive statistics + `my_user_id` |

### Ingest

| Endpoint | Description |
|----------|-------------|
| `POST /ingest` | Batch upsert messages (1–100) |
| `POST /contacts` | Batch upsert contacts |
| `POST /deleted` | Mark messages as deleted |

### Config

| Endpoint | Description |
|----------|-------------|
| `GET/POST /config` | Global or per-account `sync_mode` |
| `GET/POST /chats/config` | Per-chat `sync` + `label` |
| `DELETE /chats/config/:id` | Remove chat override |

### Outbox

| Endpoint | Description |
|----------|-------------|
| `POST /outbox` | Create draft/pending/scheduled/mass send |
| `GET /outbox` | List items, filter by `status` |
| `GET /outbox/due` | GramJS: atomically claim due items |
| `PATCH /outbox/:id` | Edit draft |
| `DELETE /outbox/:id` | Delete draft |
| `POST /outbox/:id/send` | Promote draft to pending/scheduled |
| `POST /outbox/:id/ack` | GramJS: report send result |

### Actions

| Endpoint | Description |
|----------|-------------|
| `POST /actions/edit` | Queue message edit |
| `POST /actions/delete` | Queue message delete (revoke) |
| `POST /actions/forward` | Queue message forward |
| `GET /actions/pending` | GramJS: fetch pending actions |
| `POST /actions/:id/ack` | GramJS: report action result |

### Backfill

| Endpoint | Description |
|----------|-------------|
| `POST /backfill/seed` | Register dialogs in backfill_state |
| `GET /backfill/pending` | Get pending/in_progress dialogs |
| `POST /backfill/progress` | Update backfill progress |

### MCP

`POST /mcp` — JSON-RPC 2.0 MCP server. Tools: `search`, `chats`, `history`, `contacts`, `recent`, `stats`, `digest`, `thread`, `send`, `draft`, `edit_message`, `delete_message`, `forward_message`.

---

## Search

PostgreSQL FTS using `tsvector` generated column + GIN index. Query uses prefix matching (`token:*`) with `&` operator. Keyset pagination via `before_id` + `before_sent_at` (not offset).

```
Response: { results: [...], total: N, limit: N, next_before_id: N|null, next_before_sent_at: N|null }
```

---

## Auth

Single token (`X-Ingest-Token`) for all endpoints. `X-Account-ID` identifies the account (numeric Telegram user ID). MCP also accepts `?token=` and `?account_id=` query params.

Username-to-account-ID resolution: the `contacts` table stores the account owner as a self-entry (`account_id = tg_user_id`). The Worker resolves a username alias by querying `contacts WHERE username = $1 AND account_id = tg_user_id`.

---

## Backup

Scheduled Worker cron (daily at 03:00 UTC) dumps `SELECT * FROM messages` to Cloudflare R2 as newline-delimited JSON. 30-day TTL on R2 objects.

---

## Operational Notes

- **Database**: Neon serverless HTTP (`@neondatabase/serverless`). No connection pooling needed — each Worker request gets a fresh HTTP connection.
- **Schema migrations**: `schema.sql` uses `IF NOT EXISTS` everywhere — safe to re-run on live DB.
- **Stuck sends**: outbox items stuck in `sending` for >5 minutes are reset to `pending` on next `/outbox/due` poll. Failed recipients in mass sends are also reset.
- **Edit archive consistency**: GramJS `EditedMessage` event fires after `editMessage()` call — archive is updated automatically with correct `sent_at`. No manual re-ingest needed.
- **Outgoing message identification**: `sender_id = account_id`. No `direction` column exists — it was redundant and has been removed.
