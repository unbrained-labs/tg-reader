# MCP Tool Reference

Complete reference for all 27 MCP tools exposed at `/mcp`. Connect via:

```
Authorization: Bearer <token>
X-Account-ID: <account_id>   # e.g. your-username, or 'primary'
```

---

## Read tools (available to all tokens)

### `search`

Full-text search across the complete message archive. Results ranked by recency.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Search keywords — AND semantics, all words must appear. Use single short tokens if broad queries return 0 results. |
| `chat_id` | string | no | Restrict to one chat (get IDs from `chats`). |
| `sender_username` | string | no | Filter by sender username (without @). |
| `from` | string | no | Start date — ISO 8601 (`2024-01-15`) or Unix epoch seconds. |
| `to` | string | no | End date — ISO 8601 or Unix epoch seconds. Defaults to tomorrow. |
| `limit` | number | no | Results per page, default 20, max 50. |
| `before_id` | number | no | Keyset cursor — pass `next_before_id` from previous response. |
| `before_sent_at` | number | no | Keyset cursor — pass `next_before_sent_at`. Required when using `before_id`. |

Returns `{ results[], total, limit, next_before_id, next_before_sent_at }`.

---

### `chats`

List all chats with message counts, last activity, and label.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | Partial match on chat name (case-insensitive). |
| `label` | string | no | Filter by label (e.g. `work`, `personal`). |
| `chat_type` | string | no | `user` · `group` · `supergroup` · `channel` |
| `filter` | string | no | `unanswered` — chats where the last message is from someone else (CRM use case). |
| `sort_by` | string | no | `last_activity` (default) or `message_count`. |

Returns array of `{ tg_chat_id, chat_name, chat_type, message_count, last_message_at, sync_status, label }`.

---

### `history`

Get messages from one chat, oldest-first. Paginate forward with `next_after_id` + `next_after_sent_at`.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | string | yes | Chat ID — get from `chats`. |
| `limit` | number | no | Messages per page, default 20, max 50. |
| `after_id` | number | no | Pagination — pass `next_after_id` from previous response. |
| `after_sent_at` | number | no | Pagination — pass `next_after_sent_at`. Required with `after_id`. |

---

### `contacts`

List Telegram contacts with username, name, and message count.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `search` | string | no | Filter by name or username (partial match). |
| `has_messages` | boolean | no | If true, only contacts with at least one message in the archive. |

Useful for resolving a name to a `tg_user_id` before searching.

---

### `recent`

Most recent messages across all chats, newest-first. Use only for "what's new" queries — use `search` for historical lookups.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | number | no | Default 20, max 50. |

---

### `stats`

Archive statistics. Call first when asked about the archive scope.

Returns `{ total_messages, total_chats, earliest_message_at, latest_message_at, deleted_count, edited_count, sent_count, received_count, total_contacts, my_user_id }`.

`earliest_message_at` and `latest_message_at` are Unix epoch seconds.

---

### `digest`

Recent messages grouped by chat — ideal for morning briefings and "what happened today/this week" queries.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `hours` | number | no | Look-back window, default 24. Use 168 for a weekly digest. |
| `per_chat` | number | no | Max messages per chat, default 5, max 20. |
| `label` | string | no | Filter to chats with this label. |

---

### `thread`

Reconstruct a reply thread — returns a parent message and all its direct replies.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | string | yes | Chat containing the message. |
| `message_id` | string | yes | `tg_message_id` of the message to thread around. |
| `limit` | number | no | Max replies, default 50, max 200. |
| `after_id` | number | no | Pagination cursor. |

---

### `whoami`

Returns the identity and permissions of the current caller — whether MASTER_TOKEN or a scoped token, and the associated role with read/write capabilities.

No parameters.

---

## Write tools (require `can_send` / `can_edit` / `can_delete` / `can_forward` on role)

### `send`

Queue a message for immediate sending (or schedule it). GramJS picks it up within 30 seconds.

**Single send:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tg_chat_id` | string | yes* | Target chat ID. Omit for mass send. |
| `text` | string | yes | Message text. Supports `{first_name}`, `{last_name}`, `{username}`, `{user}` placeholders. |
| `reply_to_message_id` | number | no | Reply to this message ID. |
| `scheduled_at` | number | no | Unix epoch seconds to send at. Omit to send immediately. |

**Mass send** (omit `tg_chat_id`, provide `recipients`):

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Message text with optional placeholders. |
| `recipients` | array | yes | Array of `{ tg_chat_id, first_name?, last_name?, username? }` objects. |

**Mass send limits** (enforced before any rows are written):
- Default cap: **25 recipients** per request
- Default gate: **contacts-only** — all `tg_chat_id` values must be in the `contacts` table
- Every recipient must have a `tg_chat_id` — missing IDs are rejected, not skipped
- Limits are configurable via `global_config` (see `agent-permissions.md`)

Returns `{ id: N }` — the outbox ID.

---

### `draft`

Save a message as a draft (not queued yet). Same parameters as `send`. Returns outbox ID. Promote to pending/scheduled via the REST API (`POST /outbox/:id/send`).

Subject to the same mass send limits as `send`.

---

### `edit_message`

Edit an already-sent Telegram message. Queued in `pending_actions`; GramJS executes within 30 seconds.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tg_chat_id` | string | yes | Chat containing the message. |
| `tg_message_id` | string | yes | Message to edit. |
| `text` | string | yes | New text. |

---

### `delete_message`

Delete a sent message (revokes from both sides).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tg_chat_id` | string | yes | Chat containing the message. |
| `tg_message_id` | string | yes | Message to delete. |

---

### `forward_message`

Forward a message to another chat.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tg_chat_id` | string | yes | Source chat ID. |
| `tg_message_id` | string | yes | Message to forward. |
| `to_chat_id` | string | yes | Destination chat ID. |

---

### `outbox_status`

Check delivery status of a sent or scheduled message.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | number | yes | Outbox ID returned by `send` or `draft`. |

Returns `{ id, status, sent_at, error, recipients[] }`.

Status lifecycle: `draft` → `pending` / `scheduled` → `sending` → `sent` / `failed` / `partial`

---

## Admin tools (MASTER_TOKEN only)

### `create_role`

Create a new RBAC role.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Unique role name (e.g. `work-reader`, `dm-assistant`). |
| `read_mode` | string | `all` · `whitelist` · `blacklist` |
| `read_labels` | string[] | Whitelist/blacklist by label (e.g. `["work","clients"]`). |
| `read_chat_ids` | string[] | Whitelist/blacklist by specific chat IDs. |
| `can_send` | boolean | Default false. |
| `can_edit` | boolean | Default false. |
| `can_delete` | boolean | Default false. |
| `can_forward` | boolean | Default false. |
| `write_chat_types` | string[] | Restrict writes to these chat types. Null = inherit read scope. |
| `write_labels` | string[] | Restrict writes to chats with these labels. |
| `write_chat_ids` | string[] | Restrict writes to these chat IDs. |

---

### `list_roles`

List all roles with permissions and scope. No parameters.

---

### `update_role`

Update fields on an existing role. Only provided fields are changed.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Current role name to update. |
| `new_name` | string | Optional rename. |
| (any role field) | | Same fields as `create_role`. |

---

### `delete_role`

Delete a role by name. Fails if any token still references it.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Role name to delete. |

---

### `create_token`

Create a scoped agent token. **Returns the raw token once** — store it immediately, it cannot be recovered.

| Param | Type | Description |
|-------|------|-------------|
| `role` | string | Role name to bind this token to. |
| `label` | string | Optional human-readable label (e.g. `Claude work assistant`). |
| `account_id` | string | Account to bind to. Default `primary`. |
| `expires_at` | number | Optional expiry (Unix epoch seconds). |

---

### `list_tokens`

List all agent tokens with label, role, expiry, and last-used timestamp. Raw token values are never returned.

No parameters.

---

### `revoke_token`

Permanently delete an agent token. Audit log rows are preserved.

| Param | Type | Description |
|-------|------|-------------|
| `token_id` | string | Token ID (string) as returned by `list_tokens`. |

---

### `create_job`

Create an observer job that runs an AI agent on a schedule or message trigger.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Unique job name. |
| `schedule` | string | Stored cron expression (reference only — actual frequency is `cooldown_secs` + 15-min tick). |
| `trigger_type` | string | `new_message` · `keyword` · `unanswered` |
| `trigger_config` | object | Trigger config: `{ chat_id?, label?, keywords?, hours? }`. |
| `model_config` | object | `{ provider, model, api_key_ref?, endpoint? }` — see below. |
| `task_prompt` | string | Agent instructions. Supports `{chat_name}`, `{chat_id}`, `{sender}`, `{snippet}`, `{timestamp}`, `{account_id}`. |
| `role` | string | Role name — a scoped token is auto-created for this job. |
| `cooldown_secs` | number | Min seconds between runs. Default 3600. |

**`model_config` providers:**

| Provider | `provider` value | `api_key_ref` | Notes |
|----------|-----------------|----------------|-------|
| Anthropic | `anthropic` | Required — secret name (e.g. `CLAUDE_API_KEY`) | Claude models |
| OpenAI | `openai` | Required — secret name | GPT models |
| Cloudflare Workers AI | `cloudflare-ai` | Not required | Free; uses Workers AI binding |

---

### `list_jobs`

List all observer jobs with status, trigger, last run time, and token label. No parameters.

---

### `toggle_job`

Enable or disable a job without revoking its token.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Job name. |
| `enabled` | boolean | `true` to enable, `false` to disable. |

---

### `delete_job`

Delete a job by name. The associated token is **not** auto-revoked — use `revoke_token` separately if needed.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Job name to delete. |

---

### `update_job`

Update fields on an existing job. Only provided fields are changed.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Job name to update. |
| (any job field) | | Same fields as `create_job`. |

---

## Data types reference

### Timestamps

All timestamps (`sent_at`, `edit_date`, `deleted_at`, `scheduled_at`, `earliest_message_at`, `latest_message_at`) are **Unix epoch seconds** (integer). Multiply by 1000 for JavaScript `Date`.

### IDs

`tg_chat_id`, `tg_message_id`, `sender_id`, `tg_user_id` are all **strings** — Telegram IDs are 64-bit integers that overflow JavaScript `number`.

### `chat_type`

`user` (DM) · `group` · `supergroup` · `channel` · `bot`

### Deleted and edited messages

- Deleted: soft-deleted with `is_deleted=1`, content preserved, excluded from search by default.
- Edited: `original_text` holds the pre-edit content; `text` is always the latest version.
