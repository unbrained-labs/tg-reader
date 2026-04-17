# MCP / AI Agent Guide

tg-reader exposes an MCP (Model Context Protocol) server that lets Claude and other AI agents query and write to your Telegram account directly.

## Connecting

### Claude Code CLI (recommended)

Header-based auth keeps the token out of URL-based logs:

```bash
claude mcp add --transport http tg-reader \
  "https://<worker>/mcp?account_id=<username-or-id>" \
  --header "Authorization: Bearer <ingest-token>"
```

Use your Telegram **username** (e.g. `john`) or numeric user ID for `account_id`. The worker resolves usernames automatically via the contacts table self-entry populated on first listener startup.

### claude.ai custom connector (fallback)

The claude.ai connector dialog doesn't accept custom headers, so the token has to live in the URL query string:

1. Go to **Settings → Connectors → Add custom connector**
2. Enter the URL with your credentials embedded:

```
https://<worker>/mcp?token=<ingest-token>&account_id=<username-or-id>
```

3. Leave OAuth fields empty. Click **Add**.

The query-string token ends up in Cloudflare access logs and URL-based telemetry. If you care about log hygiene, prefer the CLI install above.

---

## Using it

Once connected, just talk to Claude normally. No commands, no syntax — Claude knows how to query and write to the archive.

**Read prompts:**
- *"What did I talk about with John last week?"*
- *"Find all messages mentioning the invoice from March"*
- *"Give me a morning briefing of my work chats"*
- *"What todos came up in my work chats today?"*

**Write prompts:**
- *"Send a message to @username saying I'll be 10 minutes late"*
- *"Draft a reply to the last message in the Project Alpha group"*
- *"Schedule a follow-up to John for tomorrow at 9am"*
- *"Edit the last message I sent to say 'confirmed' instead of 'ok'"*

---

## Read tools

### `search` — primary tool

Full-text search across all messages. **Use this for any question about past conversations.**

```json
{
  "query": "invoice payment",
  "chat_id": "optional",
  "from": "2024-01-01",
  "to": "2024-06-30",
  "limit": 20,
  "before_id": 12345
}
```

### `chats`

Lists all chats with message counts, last activity, and label (work/personal). Filter by `name` or `label`.

```json
{ "name": "Alpha", "label": "work" }
```

### `history`

Returns messages from one chat in chronological order.

```json
{ "chat_id": "12345678", "limit": 20 }
```

### `contacts`

Lists contacts with names, usernames, and message counts.

```json
{ "search": "john" }
```

### `recent`

Returns the most recent messages across all chats.

### `stats`

Archive statistics — total messages, date range, chats, contacts. Also returns `my_user_id` (your Telegram ID).

### `digest`

Recent messages grouped by chat — ideal for briefings and catch-up.

```json
{ "hours": 24, "per_chat": 5, "label": "work" }
```

### `thread`

Reconstructs a reply thread — the message, its parent, and all direct replies.

```json
{ "chat_id": "12345678", "message_id": "99999" }
```

---

## Write tools

All write actions are queued in the database and executed by GramJS within **30 seconds**.

### `send`

Queue a message for immediate or scheduled sending.

```json
{
  "tg_chat_id": "12345678",
  "text": "Hello!",
  "reply_to_message_id": 99999,
  "scheduled_at": 1735689600
}
```

**Mass send** — omit `tg_chat_id`, provide `recipients` instead:

```json
{
  "text": "Hi {first_name}, just checking in!",
  "recipients": [
    { "tg_chat_id": "111", "first_name": "Alice" },
    { "tg_chat_id": "222", "first_name": "Bob" }
  ]
}
```

Placeholders: `{user}` (first name → @username → "there"), `{first_name}`, `{last_name}`, `{username}`.

### `draft`

Save a message without sending it. Returns an `id` you can promote later via `POST /outbox/:id/send`.

### `edit_message`

Queue an edit to an already-sent message. Archive is updated automatically when GramJS applies it.

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999", "text": "Updated text" }
```

### `delete_message`

Queue a delete (revokes from both sides).

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999" }
```

### `forward_message`

Forward a message to another chat.

```json
{ "tg_chat_id": "12345678", "tg_message_id": "99999", "to_chat_id": "87654321" }
```

---

## Agentic workflow example — daily work todos

```
1. digest(hours=24, label="work")   → scan recent work chats
2. search(query="todo action need", from=today)   → find task language
3. For each actionable item: draft() a summary or send() a reminder
```

---

## Tool selection guide

| User asks | Use |
|-----------|-----|
| About a past conversation or topic | `search` |
| Morning briefing / catch-up | `digest` |
| Full context of a reply | `thread` |
| To browse a conversation | `chats` → `history` |
| Who someone is / find a person | `contacts` |
| What's the latest activity | `recent` |
| Send a message now | `send` |
| Save for later | `draft` |
| Fix a sent message | `edit_message` |
| Remove a sent message | `delete_message` |

---

## Chat labels

Assign `work` / `personal` (or any tag) to chats via `POST /chats/config`:

```json
{ "tg_chat_id": "12345678", "label": "work" }
```

Then filter any tool by `label` — e.g. `digest(label="work")` or `chats(label="personal")`.

---

## Tips for agents

- The archive is **complete and historical** — do not assume data is missing if a first search returns nothing. Try different keywords or a wider date range.
- Always use `from`/`to` when the user mentions a time period.
- `direction: "out"` = sent by the account owner, `direction: "in"` = received.
- `my_user_id` from `stats` is your own Telegram ID — useful for filtering outgoing messages.
- Write tools return an `id` and a `note` explaining when GramJS will execute the action.

---

## Multiple accounts

Each account has its own connector URL with a different `account_id`. Data is fully isolated between accounts.

---

## Claude Code / API access

For programmatic use outside claude.ai, the MCP endpoint is `POST /mcp` with standard JSON-RPC 2.0 payloads. Auth is via `Authorization: Bearer <token>` (preferred) or `X-Ingest-Token: <token>` header; `?token=` query param is a fallback for clients that can't set headers. `X-Account-ID` identifies the account (or `?account_id=` query param).
