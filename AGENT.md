# Telegram Archive — Agent Guide

This is a complete personal Telegram message archive. Every message sent and received is stored and searchable. This guide tells you everything you need to query and manage it.

---

## What's in the archive

- **100,000+ messages** across all chats (DMs, groups, channels)
- **History going back to 2020**
- **Multiple accounts supported** — each has its own isolated dataset, identified by `account_id`
- Messages include: text, media type, sender, direction (sent/received), timestamps, reply context, forwarded-from info
- Contacts table with names, usernames, phone numbers

---

## MCP Connector

The archive is exposed as an MCP server. Connect via:

```
POST https://<your-worker>.workers.dev/mcp?account_id=<id>
Authorization: Bearer <token>
```

(Or pass the token as `?token=<token>` in the URL if your client can't set headers — less secure.)

### Tools

#### `search` — your primary tool
Full-text search across all messages. **Use this for any question about past conversations.**

```json
{
  "query": "payment invoice",
  "chat_id": "optional — filter to one chat",
  "from": "2024-01-01",
  "to": "2024-06-30",
  "limit": 20,
  "before_id": 12345
}
```

- Words are ANDed — `payment invoice` finds messages containing both
- `from`/`to` accept ISO dates or Unix timestamps
- If results are empty, try broader terms or wider date range
- Paginate by passing `next_before_id` from the response as `before_id`

#### `chats` — discover chat IDs
Lists all chats with message counts and last activity. Call this first when:
- User references a chat by name and you need its ID
- User wants to know which chats they have

No parameters required.

#### `history` — read a conversation thread
Returns messages from one chat in chronological order. Use when the user wants to read a conversation, not find something specific.

```json
{
  "chat_id": "12345678",
  "limit": 20,
  "before_id": 99999
}
```

For finding content within a chat, use `search` with `chat_id` filter instead.

#### `contacts` — find people
Lists contacts with names, usernames, and message counts.

```json
{ "search": "john" }
```

Use to resolve who someone is before searching their messages.

#### `recent` — latest activity
Returns the most recent messages across all chats. Only useful for "what's new" queries. For anything historical, use `search`.

---

## Decision tree

```
User asks about a past conversation or specific content
  → search (with date range if mentioned)

User asks "show me my conversation with X"
  → contacts (find X) → history (read thread)

User asks "which chats do I have" or "find the chat about Y"
  → chats

User asks "what's the latest" or "what did I miss"
  → recent

User asks to find a specific person
  → contacts
```

---

## Sync configuration

Control what gets captured going forward.

### Global mode

**Current default: `all` (capture everything)**

| Mode | Behaviour |
|------|-----------|
| `all` | Capture all chats |
| `blacklist` | Capture everything except excluded chats |
| `whitelist` | Capture only explicitly included chats |
| `none` | Pause all capture |

Change via API:
```
POST /config
{ "sync_mode": "whitelist" }
```

### Per-chat overrides

```
POST /chats/config
{ "tg_chat_id": "12345678", "sync": "include" }   // whitelist mode
{ "tg_chat_id": "12345678", "sync": "exclude" }   // blacklist mode
```

Get current overrides:
```
GET /chats/config
```

Delete an override:
```
DELETE /chats/config/12345678
```

---

## REST API reference

All endpoints require:
```
X-Ingest-Token: <token>
X-Account-ID: <account_id>
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search?q=...` | Full-text search |
| `GET` | `/chats` | List all chats |
| `GET` | `/contacts` | List contacts |
| `GET` | `/config` | Get global sync mode |
| `POST` | `/config` | Set global sync mode |
| `GET` | `/chats/config` | Get per-chat overrides |
| `POST` | `/chats/config` | Add/update per-chat override |
| `DELETE` | `/chats/config/:chat_id` | Remove override |

### Search parameters

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Full-text search query |
| `chat_id` | string | Filter to one chat |
| `sender_username` | string | Filter by sender |
| `from` | string | Start date (ISO or epoch) |
| `to` | string | End date (ISO or epoch) |
| `limit` | number | Results per page (max 100) |
| `before_id` | number | Pagination cursor |

---

## Data notes

- `tg_chat_id` and `sender_id` are strings (Telegram IDs are 64-bit)
- `sent_at` is Unix epoch seconds
- `direction`: `"out"` = sent by the account owner, `"in"` = received
- `message_type`: `text`, `photo`, `video`, `audio`, `document`, `sticker`, `voice`, `video_note`, `service`
- Deleted messages are soft-deleted (`is_deleted=1`), not removed
- Edited messages preserve `original_text`
