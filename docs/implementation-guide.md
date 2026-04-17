# RBAC + Observer Jobs — Implementation Guide

This doc is the entry point for implementing `docs/agent-permissions.md` and
`docs/observer-jobs.md`. Read this first, then read those two docs, then read
the codebase. All three together are enough context to implement without
ambiguity.

---

## Codebase orientation

```
worker/
  src/
    index.ts      — all Worker logic (handlers, MCP dispatch, scheduled cron)
    types.ts      — Env interface + domain types
  wrangler.toml   — bindings, cron triggers, secrets list
schema.sql        — single source of truth for DB schema
```

Key sections in `index.ts` (search by line comment):

| Section | Description |
|---|---|
| `authenticate()` ~L50 | Current auth — X-Ingest-Token only |
| `handleSearch()` ~L206 | FTS + B-tree search handler |
| `handleChats()` ~L479 | Chats list handler |
| `dispatchMcpTool()` ~L1475 | Routes MCP tool calls to handlers |
| `handleMcp()` ~L1883 | MCP endpoint entry point |
| `scheduled()` ~L2190 | Cron handler — add job runner here |
| `export default` L2208 | `{ fetch, scheduled }` |

---

## Auth architecture — current vs target

### Current (single token, all endpoints)

```
authenticate(request, env, tokenOverride?)
  → checks X-Ingest-Token header OR ?token= query param
  → compares against env.INGEST_TOKEN (single Cloudflare secret)
  → returns null (ok) or 401 Response (fail)
```

The `/mcp` path already supports `?token=` and `?account_id=` query params
(required for the claude.ai connector dialog which can't send custom headers).
This is intentional — keep it.

### Target (three auth paths)

Replace `authenticate()` with a more capable version:

```
POST /mcp?token=xxx&account_id=yyy
  → if token === env.MASTER_TOKEN: full access, skip RBAC
  → else: SHA-256(token) → lookup agent_tokens table → get token_id + role
          → check expires_at
          → check token_account_roles for (token_id, account_id)
          → inject role into request context for handler use

X-Ingest-Token on all other endpoints (/ingest, /backfill/*, etc.)
  → unchanged — still compares against env.INGEST_TOKEN
```

**MASTER_TOKEN is a new Cloudflare secret.** Add to `types.ts` Env interface:
```ts
export interface Env {
  DATABASE_URL: string;
  BACKUP_BUCKET: R2Bucket;
  INGEST_TOKEN: string;
  MASTER_TOKEN: string;  // ADD THIS
}
```

Set it in production:
```bash
wrangler secret put MASTER_TOKEN
```

---

## Token context threading

The central refactor: `dispatchMcpTool` must receive the resolved token context
so handlers can enforce read scope and write permissions.

Current signature:
```ts
async function dispatchMcpTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  accountId: string,
): Promise<unknown>
```

Target signature:
```ts
interface TokenContext {
  token_id: bigint | null;   // null = MASTER_TOKEN (bypass all checks)
  role: RoleRow | null;       // null = MASTER_TOKEN
}

async function dispatchMcpTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  accountId: string,
  ctx: TokenContext,          // ADD THIS
): Promise<unknown>
```

Pass `ctx` down to each handler that needs it. `handleMcpMessage()` already
calls `dispatchMcpTool` — update the call site there and in `runAgentLoop()`
(observer jobs).

---

## Which handlers need scope enforcement

### Read scope injection (SQL WHERE clause additions)

These handlers query messages and must inject role read scope:
- `handleSearch()` — inject into FTS and B-tree query branches
- `handleChats()` — inject to filter out chats not in read scope
- Any future `handleHistory()` type tool

**Do NOT** inject into:
- `handleGetContacts()` — contacts table is not message-scoped
- `handleStats()` — summary counts; scope injection optional (counts may reflect limited scope)
- Outbox handlers — these are write operations, separate permission model

### Write permission checks (before executing)

Before queuing outbox / pending_action:
- `dispatchMcpTool` case `'send'` → check `role.can_send` + write scope
- `dispatchMcpTool` case `'edit'` → check `role.can_edit` + write scope
- `dispatchMcpTool` case `'delete'` → check `role.can_delete` + write scope
- `dispatchMcpTool` case `'forward'` → check `role.can_forward` + write scope

Write scope check sequence:
1. Resolve target chat's `chat_type` and `label` from DB
2. Check `write_chat_types` if set
3. Check `write_labels` if set
4. Check `write_chat_ids` if set
5. On pass: execute + write audit_log row
6. On fail: return `{ error: 'permission_denied', message: '...' }`

If all `write_*` fields are null, inherit read scope for write scope.

---

## Read scope SQL patterns

Use parameterized queries. Examples:

```sql
-- whitelist by label
AND m.tg_chat_id IN (
  SELECT cc.tg_chat_id FROM chat_config cc
  WHERE cc.account_id = $1 AND cc.label = ANY($N::text[])
)

-- blacklist by label
AND m.tg_chat_id NOT IN (
  SELECT cc.tg_chat_id FROM chat_config cc
  WHERE cc.account_id = $1 AND cc.label = ANY($N::text[])
)

-- whitelist by chat_id
AND m.tg_chat_id = ANY($N::text[])
```

When both `read_labels` and `read_chat_ids` are set: treat as OR
(either condition passes the message through).

`read_mode = 'all'` → no clause injected.

---

## MASTER_TOKEN MCP tools

MASTER_TOKEN callers get access to permission-management tools:
`create_role`, `list_roles`, `update_role`, `delete_role`,
`create_token`, `list_tokens`, `revoke_token`.

Implement these as cases in `dispatchMcpTool`. Guard:
```ts
if (ctx.token_id !== null) {
  return { error: 'permission_denied', message: 'MASTER_TOKEN required' };
}
```

Regular agent callers get `whoami` only (returns their role + permissions).

---

## `create_token` — multi-account shape

The `account_ids` parameter accepts a single string or array:

```json
{ "label": "work-bot", "role": "read-work", "account_id": "<another-account-id>" }
{ "label": "shared", "role": "read-all", "account_ids": ["111", "222"] }
```

Implementation: normalize to array, then insert one row per account_id
into `token_account_roles`.

---

## DB schema additions

Add to `schema.sql`. Run against Neon after adding:
```bash
psql "$DATABASE_URL" -f schema.sql   # idempotent with IF NOT EXISTS
```

New tables: `roles`, `agent_tokens`, `token_account_roles`, `audit_log`, `jobs`.
See `docs/agent-permissions.md` and `docs/observer-jobs.md` for exact DDL.

---

## Observer jobs — wrangler.toml change

Add the jobs cron to the existing triggers block in `worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * *", "0 4 1 * *", "*/15 * * * *"]
#        daily backup   monthly chk   job runner
```

Then in `scheduled()` in `index.ts`, add a branch:
```ts
const CRON_JOB_RUNNER = '*/15 * * * *';

if (event.cron === CRON_JOB_RUNNER) {
  await runJobs(env);
}
```

The `scheduled()` handler already exists at the bottom of `index.ts` with the
existing cron constants — add alongside.

---

## Observer jobs — Cloudflare Workers limits

Cloudflare Workers Paid plan:
- **CPU time**: 30 seconds per invocation (scheduled events get same limit)
- **Wall clock**: up to 15 minutes with `ctx.waitUntil()`

For observer jobs: each `runAgentLoop()` call makes external model API calls
(network I/O doesn't count toward CPU time). Multi-turn agent loops with 5-10
tool calls are well within limits. Use `ctx.waitUntil(promise)` in the
`scheduled()` handler to allow the loop to complete asynchronously:

```ts
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(runJobs(env));
}
```

---

## Job error logging

On model API failure or job loop error: log to `console.error` (appears in
Cloudflare Workers logs / `wrangler tail`). Do not throw — catch per-job and
continue to next job. Future enhancement: write to an `audit_log` row with
`action = 'job_error'`.

---

## `last_used_at` update strategy

On each successful agent token auth, update `last_used_at` at most once per day:

```sql
UPDATE agent_tokens
SET last_used_at = $1
WHERE id = $2
  AND (last_used_at IS NULL OR last_used_at < $3)
```

Where `$1` = now (unix), `$2` = token_id, `$3` = start of today (unix).
This is a conditional update — cheap, no extra SELECT needed.

---

## Timestamp convention reminder

All timestamps in storage: Unix epoch **seconds** (INTEGER/BIGINT).
MCP tool outputs: ISO 8601 for human-meaningful fields, Unix integers for
pagination cursors. See `docs/conventions.md` for the full table.

When implementing RBAC tool outputs (`list_tokens`, `list_roles`, `list_jobs`):
- `expires_at`, `last_used_at`, `created_at`, `last_run_at` → ISO 8601
- Pagination cursors (if any) → Unix integer

Use the existing `toISO()` pattern:
```ts
function toISO(unix: number | null): string | null {
  return unix !== null ? new Date(unix * 1000).toISOString() : null;
}
```

---

## Testing checklist

After implementation, verify:

- [ ] MASTER_TOKEN auth: management tools accessible, read/write tools accessible
- [ ] Agent token auth: only role-scoped data returned from search/chats
- [ ] Whitelist role: direct chat_id query for out-of-scope chat returns empty
- [ ] Blacklist role: excluded chat does not appear in results
- [ ] Expired token: returns 401
- [ ] Revoked token: returns 401
- [ ] Write with can_send=0: returns permission_denied
- [ ] Write to out-of-scope chat_type: returns permission_denied with specifics
- [ ] audit_log row written on successful send
- [ ] Job cron fires at */15 and executes enabled jobs
- [ ] Job with null token_id: skipped silently
- [ ] Job cooldown: job with last_run_at < cooldown_secs ago is skipped
