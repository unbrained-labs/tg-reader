# REST API Reference

> Machine-readable spec: [`openapi.yaml`](../openapi.yaml) — import into Postman, Insomnia, or view at [editor.swagger.io](https://editor.swagger.io).

All endpoints are on the Cloudflare Worker URL. All requests require:

```
X-Ingest-Token: <your-token>
X-Account-ID: <account-id>
```

---

## Read endpoints

### GET /search

Full-text search across all archived messages.

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query — words are ANDed |
| `chat_id` | string | Filter to a specific chat |
| `sender_username` | string | Filter by sender username |
| `from` | string | Start date — ISO 8601 or Unix timestamp |
| `to` | string | End date — ISO 8601 or Unix timestamp |
| `limit` | number | Results per page, default 20, max 100 |
| `before_id` | number | Pagination cursor from previous response |

### GET /chats

Lists all chats with message counts, last activity, and label.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Filter by chat name (partial, case-insensitive) |
| `label` | string | Filter by label (e.g. `work`, `personal`) |

### GET /contacts

Lists contacts with names, usernames, and message counts.

| Param | Type | Description |
|-------|------|-------------|
| `search` | string | Filter by name or username |

### GET /stats

Archive statistics — total messages, chats, contacts, date range, `my_user_id`.

---

## Chat config

### GET /chats/config

Returns per-chat sync settings and labels.

### POST /chats/config

```json
{
  "tg_chat_id": "12345678",
  "chat_name": "optional",
  "sync": "include|exclude",
  "label": "work"
}
```

`sync` and `label` are both optional — omitting one preserves the existing value.

### DELETE /chats/config/:tg_chat_id

Remove a chat's config entry.

---

## Outbox (write)

All outbox items are picked up by GramJS within 30 seconds.

### POST /outbox

Create a draft, pending send, scheduled send, or mass send.

```json
{
  "tg_chat_id": "12345678",
  "text": "Hello!",
  "status": "pending",
  "reply_to_message_id": 99999,
  "scheduled_at": 1735689600
}
```

For mass sends, omit `tg_chat_id` and provide `recipients`:

```json
{
  "text": "Hi {first_name}!",
  "status": "pending",
  "recipients": [
    { "tg_chat_id": "111", "first_name": "Alice", "username": "alice" }
  ]
}
```

**Status values:** `draft` · `pending` · `scheduled`

### GET /outbox

List outbox items. Filter with `?status=draft` etc.

### GET /outbox/due

GramJS polling endpoint — atomically claims pending/due items and marks them `sending`.

### PATCH /outbox/:id

Update a draft (only works while `status=draft`).

```json
{ "text": "Updated text", "scheduled_at": null }
```

### DELETE /outbox/:id

Delete a draft (only works while `status=draft`).

### POST /outbox/:id/send

Promote a draft to `pending` (immediate) or `scheduled` (pass `scheduled_at`).

```json
{ "scheduled_at": 1735689600 }
```

### POST /outbox/:id/ack

GramJS reports send result.

```json
{
  "status": "sent|failed|partial",
  "sent_at": 1704067200,
  "error": "optional",
  "results": [
    { "id": 1, "status": "sent", "sent_at": 1704067200 }
  ]
}
```

---

## Pending actions (write)

Edit, delete, and forward already-sent messages. GramJS executes within 30 seconds.

### POST /actions/edit

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999", "text": "New text" }
```

### POST /actions/delete

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999" }
```

### POST /actions/forward

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999", "to_chat_id": "87654321" }
```

### GET /actions/pending

GramJS polling endpoint — returns all pending actions.

### POST /actions/:id/ack

GramJS reports action result.

```json
{ "status": "done|failed", "error": "optional" }
```

---

## Data reference

### `direction`
- `"out"` — sent by the account owner
- `"in"` — received

### `chat_type`
`user` (DM) · `group` · `supergroup` · `channel` · `bot`

### Timestamps
All timestamps (`sent_at`, `edit_date`, `deleted_at`, `scheduled_at`) are **Unix epoch seconds**.

### Deleted messages
Soft-deleted — `is_deleted=1`, `deleted_at` set. Content preserved.

### Edited messages
`original_text` contains the pre-edit text. `text` is always the latest version.

### Outbox status lifecycle
`draft` → `pending` / `scheduled` → `sending` → `sent` / `failed` / `partial`
