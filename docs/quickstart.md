# Quickstart

Get an AI agent reading (and optionally writing to) your Telegram archive in 10 minutes. This assumes the Worker and GramJS listener are already deployed — see [setup.md](setup.md) if not.

---

## Step 1 — Connect Claude to the MCP endpoint

In Claude Desktop or claude.ai, add a new MCP server:

```json
{
  "mcpServers": {
    "tg-reader": {
      "url": "https://tg-reader.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your-MASTER_TOKEN>",
        "X-Account-ID": "<your-account-id>"
      }
    }
  }
}
```

Replace:
- `<your-subdomain>` — your Cloudflare Workers subdomain
- `<your-MASTER_TOKEN>` — the `MASTER_TOKEN` secret you set in Wrangler
- `<your-account-id>` — your Telegram username or `primary`

You can find your `account_id` by asking Claude: **"Call the stats tool and tell me my account ID."** It's the value in `my_user_id` if you used your numeric ID, or the username you used during backfill.

> **Using MASTER_TOKEN directly** is fine for personal use. For shared or automated agents, create scoped tokens (Step 3).

---

## Step 2 — Verify it works

Ask Claude:

> "How many messages are in my Telegram archive? What's the date range?"

Claude will call `stats` and reply with your total message count, earliest and latest message dates, and number of chats.

Try a search:

> "Search my Telegram archive for messages about invoices from January 2024."

---

## Step 3 — Create a scoped read-only token (optional but recommended)

For agents that only need to read — no sending:

```
Create a role called "reader" with read_mode "all".
Then create a token with that role, label "Claude read-only", account_id "<your-username>".
```

Claude will create the role, create the token, and return the raw token value. **Copy it immediately** — it's shown only once.

Use this token in a separate MCP config for read-only Claude sessions.

---

## Step 4 — Enable writing (optional)

To let Claude send, edit, or delete messages on your behalf:

```
Create a role called "dm-writer" with read_mode "all", can_send true, write_chat_types ["user"].
Create a token with role "dm-writer", label "Claude writer".
```

This creates a role restricted to DMs (type "user") — it cannot send to groups or channels unless you add them to `write_chat_types`.

Update your MCP config to use the new token, then try:

> "Send a message to [contact name] saying 'Heads up, call you tomorrow'."

Claude will look up the contact, confirm the chat ID, and queue the send. GramJS delivers it within 30 seconds.

---

## Step 5 — Set up an observer job (optional)

Observer jobs are AI agents that run automatically on a schedule or when triggered by new messages.

**Daily digest (free, no API key needed):**

```
Create an observer job called "morning-digest":
- schedule: "0 8 * * *"
- cooldown_secs: 82800
- model_config: { provider: "cloudflare-ai", model: "@cf/meta/llama-3.1-8b-instruct" }
- task_prompt: "Summarize the last 24 hours of messages. Group by chat. Flag anything that needs a reply."
- role: "reader"
```

The job runs on the Workers AI binding — no external API key required. It fires at most once per 23 hours (cooldown_secs) on the 15-minute cron tick.

**Check job status:**

```
List all observer jobs.
```

---

## Common questions

**How do I find someone's chat ID?**

> "Search my contacts for Alice."

Or: "List all chats with 'Alice' in the name."

**How do I see messages from a specific person?**

> "Show me all messages from @username about the project."

Claude uses `contacts` to resolve the username, then `search` with `sender_username`.

**How do I schedule a message?**

> "Schedule a message to [name] for tomorrow at 9am saying [text]."

Claude will convert the time to Unix epoch seconds and call `send` with `scheduled_at`.

**How do I stop an observer job?**

> "Disable the morning-digest job."

Uses `toggle_job` — the job and its token are preserved, just paused.

**What are the mass send limits?**

By default, mass sends are capped at 25 recipients and restricted to contacts. These limits exist to protect your Telegram account. See [agent-permissions.md](agent-permissions.md#mass-send-limits) for details on adjusting them.

---

## Reference docs

- [tool-reference.md](tool-reference.md) — all 27 MCP tools with parameters
- [agent-guide.md](agent-guide.md) — patterns and workflows for agents
- [agent-permissions.md](agent-permissions.md) — RBAC design, roles, tokens, mass send limits
- [api.md](api.md) — REST API for direct HTTP access
- [observer-jobs.md](observer-jobs.md) — observer job system in depth
