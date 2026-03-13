# tg-reader — Engineering Conventions

## Timestamp strategy

### Storage
Always Unix epoch **seconds** (BIGINT). Matches Telegram's native format. No timezone ambiguity. Integer comparison is efficient.

### Ingest (GramJS → Worker)
Unix integers. No conversion — stays close to Telegram.

### REST API responses
Unix integers. Consumers are programmatic (GramJS, scripts, other services).

### MCP tool inputs
Accept both ISO 8601 strings and Unix integers. `parseDate()` handles the conversion.

### MCP tool outputs

| Field type | Format | Examples |
|---|---|---|
| Human-meaningful timestamps | ISO 8601 (`2026-03-13T21:00:00Z`) | `sent_at`, `last_seen`, `expires_at`, `last_used_at`, `created_at` |
| Pagination cursors | Unix integer | `next_before_sent_at`, `next_after_sent_at` |

**Why:** Agents read and reason about ISO strings without conversion overhead. Pagination cursors are opaque pass-through values — the agent never interprets them, just returns them on the next call.

Example message result from MCP:
```json
{
  "tg_message_id": "48291",
  "text": "...",
  "sent_at": "2026-03-13T21:00:00Z",
  "next_before_sent_at": 1741906800,
  "next_before_id": 48290
}
```

### Implementation
Conversion happens at the MCP output layer only. Storage and internal logic always use Unix integers. Helper:
```ts
function toISO(unix: number | null): string | null {
  return unix !== null ? new Date(unix * 1000).toISOString() : null;
}
```

---

## ID strategy

All Telegram IDs stored as **TEXT**. Telegram IDs are 64-bit integers — JavaScript's `number` type loses precision above 2^53. Never cast to number for storage or comparison.

- `tg_chat_id` — TEXT, may be negative for groups/channels
- `tg_message_id` — TEXT
- `sender_id` — TEXT
- `account_id` — TEXT (numeric Telegram user ID)

---

## Null vs empty array

For JSON array columns (`read_labels`, `write_chat_ids`, etc.):

- `null` — field not set / no restriction from this field
- `[]` (empty array) — **invalid** for whitelist/blacklist scope fields; rejected at write time

Never let an empty array silently fall through to a different behaviour. Enforce at the API layer.

---

## Auth layers

| Secret | Who uses it | Scope |
|---|---|---|
| `INGEST_TOKEN` | GramJS listener + backfill | Write-only: `/ingest`, `/backfill/*`, `/contacts`, `/deleted` |
| `MASTER_TOKEN` | Owner's Claude instance | Full access including permission management |
| Agent tokens | Scoped AI agents | Read/write bounded by role |

Agent tokens travel in `Authorization: Bearer` header. Never in query params. `account_id` in query param is fine — it's not a secret.

---

## Error responses

Permission errors from the MCP layer include context for the agent:
```json
{
  "error": "permission_denied",
  "message": "This token cannot send to supergroup chats. Allowed: user, group.",
  "action": "send",
  "target_chat_type": "supergroup"
}
```

Generic errors use `{ "ok": false, "error": "..." }`. Never expose internal DB errors or stack traces.
