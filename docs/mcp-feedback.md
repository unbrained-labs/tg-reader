# MCP Feedback: tg-reader
Tested: 2026-03-13 | Agent: Claude Sonnet 4.6

---

## Issues Found & Fixed

### Issue #1: search / recent — DB error on every call (CRITICAL — FIXED)
**Tool**: `search`, `recent`
**What happened**: Every search call returned `{"ok":false,"error":"DB error"}`. Root cause: Postgres cannot infer the type of a `NULL` parameter in `$N IS NULL` when the same value also appears in an equality check. The query used `chatId` and `senderUsername` twice in binds — once for equality, once for the IS NULL guard — but Neon threw `could not determine data type of parameter $N`.
**Fix**: Collapsed duplicate bind params, switched to `$N::text IS NULL OR col = $N` pattern. Updated all downstream `$N` positional references.
**Impact**: `search` and `recent` were completely broken for all users.

---

### Issue #2: thread — always returned 0 messages (HIGH — FIXED)
**Tool**: `thread`
**What happened**: Thread reconstruction returned empty results even for messages with thousands of replies.
**Root cause**: SQL mixed internal auto-increment `id` with Telegram `reply_to_message_id` (which stores the Telegram message ID of the parent). The conditions were:
- `id = (SELECT reply_to_message_id ...)` — comparing internal row ID against Telegram msg ID
- `reply_to_message_id = (SELECT id ...)` — comparing Telegram msg ID against internal row ID
These will almost never match since the namespaces are different.
**Fix**: Changed to:
- `tg_message_id = (SELECT reply_to_message_id ...)` — find parent by its Telegram ID
- `reply_to_message_id = $3` — find replies where their parent pointer matches the target's Telegram ID

(Both comparisons are now TEXT = TEXT after the reply_to_message_id column was migrated from BIGINT to TEXT — see PR #78.)

---

### Issue #3: thread — no limit, unbounded results (HIGH — FIXED)
**Tool**: `thread`
**What happened**: A popular group chat's pinned message had 9,503 replies. `thread` returned all of them in a single response, easily exhausting an agent's context window.
**Fix**: Added `limit` (default 50, max 200) and `after_id` pagination to the tool. Updated tool definition.

---

## Agentic Observations

### Tool routing: `recent` vs `digest` overlap
Both tools answer "what's new?" but with different granularity:
- `recent` — flat list of newest messages across all chats (noisy in group-heavy accounts)
- `digest` — grouped by chat, better for catching up

**Recommendation**: Strengthen `recent` description to say "use only if you want raw newest messages; prefer `digest` for morning briefing / catch-up use cases."

### Timestamps are raw Unix epoch
Every `sent_at`, `edit_date`, `indexed_at` field is an integer like `1773394241`. Agents must mentally convert or call a tool to humanize. Not a blocker but adds friction.
**Recommendation**: Add a human-readable `sent_at_iso` field alongside `sent_at` in search/history/digest responses.

### contacts tool returns empty (no data issue, not a bug)
`total_contacts: 0` in stats — the contacts sync runs in the listener, which is currently scaled down. The tool works correctly once contacts are populated. The `search` tool with `sender_username` filter is a valid workaround.

### Missing agentic tools
| Missing | Why it matters |
|---------|---------------|
| `outbox` / `outbox_list` | Agent can't see queued/scheduled messages or drafts via MCP |
| `label_chat` | Agent can't organize chats into work/personal via MCP (REST only) |
| `find_person` | Cross-chat "find everything about person X" requires chaining contacts → search — a single tool would reduce round-trips |

### Agentic workflow example that works well
```
digest(hours=24, label="work")         # scan active work chats
→ search(query="deadline", from=today) # surface urgent items
→ draft(text="reminder: ...")          # queue a follow-up
```
Tool chaining is natural. The instructions block in `initialize` response is well-written and guides routing correctly.

---

## Test Results

| Tool | Input | Result | Notes |
|------|-------|--------|-------|
| `stats` | — | ✅ | 51,350 msgs, 205 chats |
| `chats` | — | ✅ | 205 rows, ordered by activity |
| `chats` | `name="bear"` | ✅ | Partial match works |
| `search` | `query="hello"` | ✅ (after fix) | 191 results, FTS working |
| `search` | `query="hello", from/to` | ✅ | Date filter works |
| `search` | `query="hello", chat_id` | ✅ | Chat filter works |
| `search` | pagination | ✅ | `next_before_id` cursor works |
| `search` | `query="xyznotexist"` | ✅ | Empty result, no error |
| `recent` | `limit=3` | ✅ (after fix) | Returns newest across all chats |
| `history` | `chat_id, limit=3` | ✅ | ASC order, cursor works |
| `history` | pagination | ✅ | `next_after_id` advances correctly |
| `digest` | `hours=24` | ✅ | 3 active chats in 24h |
| `digest` | `hours=168` | ✅ | 7 active chats in 1w |
| `contacts` | — | ✅ | Empty (no data synced yet) |
| `thread` | `message_id="14"` | ✅ (after fix) | 50 replies returned, paginated |
| `draft` | `text, chat_id` | ✅ | Returns `id=1`, `status=draft` |
| `send` | — | not tested | GramJS listener is down |
| `edit_message` | — | not tested | GramJS listener is down |
| `delete_message` | — | not tested | GramJS listener is down |
| `forward_message` | — | not tested | GramJS listener is down |
