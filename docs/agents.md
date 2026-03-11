# MCP / AI Agent Guide

tg-reader exposes an MCP (Model Context Protocol) server that lets Claude and other AI agents query your Telegram archive directly.

## Connecting

### claude.ai custom connector

1. Go to **Settings → Connectors → Add custom connector**
2. Enter the URL with your credentials embedded:

```
https://<worker>/mcp?token=<ingest-token>&account_id=<account-id>
```

3. Leave OAuth fields empty. Click **Add**.

The connector works on claude.ai web and mobile. Auth is via URL query params — the claude.ai connector dialog does not support custom headers.

---

## Using it

Once connected, just talk to Claude normally. No commands, no syntax — Claude knows how to query the archive.

**Example prompts:**

- *"What did I talk about with John last week?"*
- *"Find all messages mentioning the invoice from March"*
- *"Did anyone send me a deadline this month?"*
- *"What's the latest from the project Alpha group?"*
- *"Search for messages about the contract from Q3 2024"*
- *"Who sent me something about flights?"*
- *"Show me my conversation with @username from last Tuesday"*

Claude will automatically use date ranges, search by keyword, look up contacts, and paginate through results. You don't need to tell it which tool to use.

---

## Available tools

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

- Words are ANDed — `invoice payment` finds messages containing both words
- Use `from`/`to` whenever a time period is mentioned
- If results are empty, try broader terms or a wider date range
- Paginate using `next_before_id` from the response

### `chats`

Lists all chats with message counts and last activity. Use to discover chat IDs or find which chat a conversation happened in.

No parameters required.

### `history`

Returns messages from one chat in chronological order. Use to browse a conversation thread.

```json
{
  "chat_id": "12345678",
  "limit": 20,
  "before_id": 99999
}
```

For finding specific content within a chat, use `search` with `chat_id` instead.

### `contacts`

Lists contacts with names, usernames, and message counts.

```json
{ "search": "john" }
```

### `recent`

Returns the most recent messages across all chats. Use only for "what's new" queries — for anything historical use `search`.

---

## When to use which tool

| User asks | Use |
|-----------|-----|
| About a past conversation or topic | `search` |
| To find a specific message, amount, name | `search` with date range |
| To browse a conversation thread | `chats` → `history` |
| Which chats exist | `chats` |
| Who someone is / find a person | `contacts` |
| What's the latest activity | `recent` |

---

## Tips for agents

- The archive is **complete and historical** — do not assume data is missing if a first search returns nothing. Try different keywords or a wider date range.
- Always use `from`/`to` when the user mentions a time period.
- Use `contacts` to resolve a person's name to a `tg_chat_id` before calling `history`.
- The archive goes back to **2020** — old conversations are available.
- `direction: "out"` = sent by the account owner, `direction: "in"` = received.

---

## Multiple accounts

Each account has its own connector URL with a different `account_id`. Data is fully isolated between accounts — a query on one account never returns data from another.

---

## Claude Code / API access

For programmatic use outside claude.ai, the MCP endpoint is `POST /mcp` with standard JSON-RPC 2.0 payloads. Auth is via `X-Ingest-Token` header (or `?token=` query param) and `X-Account-ID` header (or `?account_id=` query param).
