# REST API Reference

> Machine-readable spec: [`openapi.yaml`](../openapi.yaml) — import into Postman, Insomnia, or view at [editor.swagger.io](https://editor.swagger.io).

All endpoints require:

```
X-Ingest-Token: <your-token>
X-Account-ID: <account-id>   # numeric Telegram user ID, username (e.g. 'john'), or 'primary'
```

---

## Search

### GET /search

Full-text search across all archived messages.

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search keywords — all words must appear (AND). Prefix matching enabled. |
| `chat_id` | string | Filter to a specific chat |
| `sender_username` | string | Filter by sender username (without @) |
| `from` | string | Start date — ISO 8601 (`2024-01-01`) or Unix epoch seconds |
| `to` | string | End date — ISO 8601 or Unix epoch seconds |
| `limit` | number | Results per page, default 20, max 100 |
| `before_id` | number | Keyset cursor — pass `next_before_id` from previous response |
| `before_sent_at` | number | Keyset cursor — pass `next_before_sent_at` from previous response. Required when using `before_id`. |

**Response:**

```json
{
  "results": [
    {
      "id": 12345,
      "tg_message_id": "98765",
      "tg_chat_id": "1234567890",
      "chat_name": "John Smith",
      "chat_type": "user",
      "sender_id": "1234567890",
      "sender_username": "johnsmith",
      "sender_first_name": "John",
      "sender_last_name": "Smith",
      "direction": "in",
      "message_type": "text",
      "text": "I sent the invoice payment yesterday",
      "media_type": null,
      "reply_to_message_id": null,
      "sent_at": 1704067200,
      "edit_date": null,
      "original_text": null,
      "is_deleted": 0
    }
  ],
  "total": 42,
  "limit": 20,
  "next_before_id": 12300,
  "next_before_sent_at": 1704000000
}
```

`next_before_id` and `next_before_sent_at` are `null` when there are no more results.

---

## Chats & contacts

### GET /chats

Lists all chats with message counts, last activity, and label.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Filter by name (partial, case-insensitive) |
| `label` | string | Filter by label (e.g. `work`, `personal`) |

**Response:** array of `{ tg_chat_id, chat_name, chat_type, message_count, last_message_at, sync_status, label }`

### GET /contacts

Lists contacts with names, usernames, and message counts.

| Param | Type | Description |
|-------|------|-------------|
| `search` | string | Filter by name or username |

### POST /contacts

Bulk upsert contacts (up to 500). Used by GramJS on startup.

```json
{
  "contacts": [
    {
      "tg_user_id": "123456789",
      "phone": "+1234567890",
      "username": "alice",
      "first_name": "Alice",
      "last_name": "Smith",
      "is_mutual": 1,
      "is_bot": 0
    }
  ]
}
```

### GET /stats

Archive statistics.

**Response:** `{ total_messages, total_chats, earliest_message_at, latest_message_at, deleted_count, edited_count, sent_count, received_count, total_contacts, my_user_id }`

`my_user_id` is your Telegram user ID when `X-Account-ID` is numeric, otherwise `null`.

---

## Chat config

### GET /chats/config

Returns per-chat sync settings and labels.

### POST /chats/config

```json
{
  "tg_chat_id": "12345678",
  "chat_name": "optional",
  "sync": "include",
  "label": "work"
}
```

`sync` and `label` are both optional — omitting one preserves the existing value.

### DELETE /chats/config/:tg_chat_id

Remove a chat's config entry.

---

## Ingest (internal, used by GramJS)

### POST /ingest

Batch upsert messages (1–100). Deduplicates on `(account_id, tg_chat_id, tg_message_id)`.

**Response:** `{ written: N, noop: N }`

### POST /deleted

Mark messages as deleted.

```json
{
  "messages": [
    { "tg_chat_id": "12345678", "tg_message_id": "99999" }
  ]
}
```

Up to 500 items per call.

---

## Outbox (write queue)

All outbox items are executed by GramJS within ~30 seconds.

### POST /outbox

Create a draft, immediate send, scheduled send, or mass send.

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
  "text": "Hi {first_name}, just a heads up!",
  "status": "pending",
  "recipients": [
    { "tg_chat_id": "111", "first_name": "Alice", "username": "alice" },
    { "tg_chat_id": "222", "first_name": "Bob" }
  ]
}
```

Placeholders: `{user}`, `{first_name}`, `{last_name}`, `{username}`.

**Valid `status` on create:** `draft` · `pending` · `scheduled`

**Response:** `{ id: N, status: "..." }`

### GET /outbox

List outbox items.

| Param | Description |
|-------|-------------|
| `status` | Filter: `draft`, `pending`, `scheduled`, `sending`, `sent`, `failed`, `partial` |
| `limit` | Default 50, max 200 |
| `offset` | Default 0 |

### GET /outbox/due

GramJS polling — atomically claims pending/due-scheduled items, marks them `sending`.

### PATCH /outbox/:id

Edit a draft (only while `status=draft`).

```json
{ "text": "Updated text", "scheduled_at": 1735689600 }
```

### DELETE /outbox/:id

Delete a draft (only while `status=draft`).

### POST /outbox/:id/send

Promote a draft to `pending` (send now) or `scheduled` (pass `scheduled_at`).

```json
{ "scheduled_at": 1735689600 }
```

**Response:** `{ ok: true, status: "pending" | "scheduled" }`

### POST /outbox/:id/ack

GramJS reports send result.

```json
{
  "status": "sent",
  "sent_at": 1704067200,
  "error": null,
  "results": [
    { "id": 1, "status": "sent", "sent_at": 1704067200 },
    { "id": 2, "status": "failed", "error": "USER_BANNED" }
  ]
}
```

**`results`** is for mass sends — one entry per recipient `outbox_recipients.id`.

---

## Pending actions

Edit, delete, or forward already-sent messages. GramJS executes within ~30 seconds.

### POST /actions/edit

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999", "text": "New message text" }
```

### POST /actions/delete

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999" }
```

Revokes from both sides.

### POST /actions/forward

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999", "to_chat_id": "87654321" }
```

**All action responses:** `{ id: N, action: "edit"|"delete"|"forward", status: "pending" }`

### GET /actions/pending

GramJS polling — returns all pending actions for the account.

### POST /actions/:id/ack

GramJS reports result.

```json
{ "status": "done", "error": null }
```

---

## Backfill (internal, used by GramJS)

### POST /backfill/seed

Register dialogs in `backfill_state`. Safe to re-run.

```json
{
  "dialogs": [
    { "tg_chat_id": "12345678", "chat_name": "John", "total_messages": 500 }
  ]
}
```

### GET /backfill/pending

Returns dialogs with `status IN ('pending', 'in_progress')`.

### POST /backfill/progress

Update progress for a dialog.

```json
{
  "tg_chat_id": "12345678",
  "status": "in_progress",
  "fetched_messages": 100,
  "oldest_message_id": "99800"
}
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
Soft-deleted — `is_deleted=1`, `deleted_at` set. Content preserved. Excluded from search by default.

### Edited messages
`original_text` contains the pre-edit text. `text` is always the latest version.

### Outbox status lifecycle
`draft` → `pending` / `scheduled` → `sending` → `sent` / `failed` / `partial`
