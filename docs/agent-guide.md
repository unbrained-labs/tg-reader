# Agent Guide

Practical patterns for Claude agents (or any LLM) using tg-reader via MCP.

---

## Connection

```
POST https://tg-reader.<subdomain>.workers.dev/mcp
Authorization: Bearer <token>
X-Account-ID: <your-username>   # your account_id
Content-Type: application/json
```

MASTER_TOKEN skips all role checks. Use it only for admin work — provisioning roles, tokens, and jobs. Day-to-day work should use scoped tokens.

---

## Read patterns

### Orient before searching

Start with `stats` to confirm the archive has the date range you need. Check `earliest_message_at` before promising to find something from a specific year.

```
stats → check date range
search(query="...", from="2024-01-01", to="2024-12-31")
```

### Find by person, not by chat

Use `contacts` to resolve a name to a `tg_user_id` / username, then pass `sender_username` to `search`:

```
contacts(search="Alice") → alice_username = "alice123"
search(query="invoice", sender_username="alice123")
```

### Find a chat ID before reading history

`history` requires a `chat_id`. Use `chats` first:

```
chats(name="DevOps") → tg_chat_id = "-1001234567890"
history(chat_id="-1001234567890", limit=50)
```

### Paginate correctly

Search and history both use **keyset pagination** — pass both cursor fields together:

```
# Search pagination
search(...) → { results, next_before_id, next_before_sent_at }
search(..., before_id=next_before_id, before_sent_at=next_before_sent_at)

# History pagination (forward)
history(chat_id=...) → { messages, next_after_id, next_after_sent_at }
history(chat_id=..., after_id=next_after_id, after_sent_at=next_after_sent_at)
```

### Retry with narrower query on 0 results

FTS is AND-based — all words must appear. If a search returns nothing:

1. Try a single shorter token (`blackbox` instead of `blackbox protocol`)
2. Try removing date filters
3. Try `contacts` to confirm the person is in the archive
4. Try `chats` to check if the right chat is captured

### Morning digest

```
digest(hours=24, label="work", per_chat=5)
```

Omit `label` for all chats. Use `hours=168` for a weekly catchup.

---

## Write patterns

### Always check permissions first

Call `whoami` at the start of any write-capable session to confirm the token has the right permissions:

```
whoami → { role: { can_send: 1, write_chat_types: ["user"] } }
```

If the role lacks the required permission, the operation will fail with a clear error.

### Single send

```
send(tg_chat_id="12345678", text="Hello!")
→ { id: 42 }
outbox_status(id=42)
→ { status: "sent", sent_at: 1704067200 }
```

### Scheduled send

```
send(
  tg_chat_id="12345678",
  text="Tomorrow's update",
  scheduled_at=1704153600
)
```

`scheduled_at` is a Unix epoch seconds value. Convert human dates: `new Date("2025-01-02T09:00:00Z").getTime() / 1000`.

### Reply to a message

Find the `tg_message_id` via `search` or `history`, then:

```
send(
  tg_chat_id="12345678",
  text="Got it, thanks!",
  reply_to_message_id=99999
)
```

### Mass send

Always call `contacts` first to confirm IDs. Mass send is capped at 25 recipients by default and requires all recipients to be in the contacts table.

```
# Build recipient list from contacts
contacts(search="") → pick relevant contacts
send(
  text="Hi {first_name}, wanted to follow up...",
  recipients=[
    { tg_chat_id: "111", first_name: "Alice" },
    { tg_chat_id: "222", first_name: "Bob" }
  ]
)
```

GramJS applies 2–5s random jitter between messages. A 25-recipient send takes about 1–2 minutes to fully deliver.

### Draft then review

For anything sensitive, save as draft first, inspect, then promote:

```
draft(tg_chat_id="...", text="...")
→ { id: 43 }
# human reviews via dashboard or API
# → POST /outbox/43/send   (from REST API — no MCP tool for this)
```

### Edit or delete a sent message

```
edit_message(tg_chat_id="12345678", tg_message_id="99999", text="Corrected text")
delete_message(tg_chat_id="12345678", tg_message_id="99999")
```

Both are queued in `pending_actions` and executed by GramJS within ~30 seconds.

---

## Observer job patterns

### Read-only daily digest job

```
create_role(
  name="digest-reader",
  read_mode="all"
)

create_job(
  name="daily-digest",
  schedule="0 8 * * *",
  cooldown_secs=82800,
  model_config={ provider: "cloudflare-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  task_prompt="Summarize the last 24 hours of messages across all chats. Group by chat. Highlight anything that needs a response.",
  role="digest-reader"
)
```

### Unanswered-message follow-up job

```
create_job(
  name="follow-up-checker",
  trigger_type="unanswered",
  trigger_config={ label: "work", hours: 48 },
  cooldown_secs=3600,
  model_config={ provider: "anthropic", model: "claude-opus-4-6", api_key_ref: "CLAUDE_API_KEY" },
  task_prompt="Check {chat_name} — last message from {sender} was: {snippet}. If this needs a reply, draft one and save it as a draft using the draft tool. Otherwise do nothing.",
  role="work-writer"
)
```

### Disable/enable without deleting

```
toggle_job(name="daily-digest", enabled=false)
toggle_job(name="daily-digest", enabled=true)
```

---

## RBAC setup patterns

### Read-only agent for a label

```
create_role(
  name="work-reader",
  read_mode="whitelist",
  read_labels=["work", "clients"]
)
create_token(role="work-reader", label="Claude work assistant", account_id="<your-username>")
```

### Write-capable agent restricted to DMs

```
create_role(
  name="dm-assistant",
  read_mode="all",
  can_send=true,
  can_edit=true,
  write_chat_types=["user"]   # DMs only, not groups/channels
)
create_token(role="dm-assistant", label="DM Claude")
```

### Full-access token with expiry

```
create_role(name="full", read_mode="all", can_send=true, can_edit=true, can_delete=true, can_forward=true)
create_token(role="full", label="temp-agent", expires_at=1735689600)
```

---

## Common mistakes

**Searching with too many words.** `search("sent the invoice payment on Tuesday")` will likely return 0 results — FTS requires every word to appear verbatim. Use `search("invoice payment")` instead.

**Not paginating.** If a question requires reading a full conversation thread, keep paginating `history` until `next_after_id` is null.

**Guessing chat IDs.** Never construct or guess `tg_chat_id` values. Always call `chats` to discover them.

**Sending to non-contacts without adjusting limits.** If you need to send to someone not in your contacts table, the contacts-only gate must be explicitly turned off via `global_config` — this is an admin operation, not an agent operation.

**Using MASTER_TOKEN for agent work.** MASTER_TOKEN bypasses all role checks but also bypasses per-recipient audit logging. Use scoped tokens for agent-initiated sends so there is an audit trail.
