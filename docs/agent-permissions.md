# Agent Permissions — Design Document

## Overview

tg-reader supports multiple AI agents accessing the same Telegram archive with different permission levels. Each agent gets its own token scoped to a role that defines what it can read and what it can write.

`INGEST_TOKEN` is separate — used only by GramJS (listener, backfill). Never exposed to agents.
`MASTER_TOKEN` is a separate Cloudflare secret for permission management. Kept separate from `INGEST_TOKEN` so a compromised listener never carries admin rights.

---

## Architecture

```
INGEST_TOKEN  (GramJS only)
  → /ingest, /backfill/*, /contacts, /deleted

MASTER_TOKEN  (owner / admin Claude only)
  → role and token management MCP tools
  → bypasses all role checks

Agent Token   (scoped AI agents)
  → /mcp  (Authorization: Bearer <token>)
  → read scope enforced at SQL level
  → write permissions checked before any mutation
```

Permissions are resolved per `(token, account_id)` pair — a single token can access multiple accounts, each with a different role. Passing an account_id the token has no mapping for returns 403.

---

## Schema

```sql
-- Roles are account-agnostic templates — reusable across any number of accounts.
-- The account context comes from token_account_roles, not from the role itself.
CREATE TABLE roles (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,   -- "work-reader", "dm-assistant", "full"

  -- Read scope
  read_mode     TEXT NOT NULL DEFAULT 'all',
                -- 'all' | 'whitelist' | 'blacklist'
  read_labels   TEXT,      -- JSON array e.g. ["work","clients"]
  read_chat_ids TEXT,      -- JSON array of tg_chat_ids (alternative to labels)

  -- Write permissions (all off by default)
  can_send      SMALLINT NOT NULL DEFAULT 0,
  can_edit      SMALLINT NOT NULL DEFAULT 0,
  can_delete    SMALLINT NOT NULL DEFAULT 0,
  can_forward   SMALLINT NOT NULL DEFAULT 0,

  -- Write scope (null = inherit read scope)
  write_chat_types TEXT,   -- JSON array: ["user","group","supergroup","channel"]
  write_labels     TEXT,   -- JSON array of labels
  write_chat_ids   TEXT    -- JSON array of tg_chat_ids
);

CREATE TABLE agent_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256 of the raw token, never plaintext
  label       TEXT,                  -- "work claude", "read-only scout"
  expires_at  BIGINT,                -- Unix epoch seconds, NULL = no expiry
  created_at  BIGINT NOT NULL
);

-- Many-to-many: one token can access multiple accounts, each with its own role.
-- Single-account tokens just have one row here.
CREATE TABLE token_account_roles (
  token_id    BIGINT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL,
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (token_id, account_id)
);

-- Audit log for write operations. Retention configurable via global_config.
CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id    BIGINT REFERENCES agent_tokens(id) ON DELETE SET NULL,
  account_id  TEXT NOT NULL,
  action      TEXT NOT NULL,   -- 'send' | 'edit' | 'delete' | 'forward'
  target_chat_id TEXT,
  detail      TEXT,            -- JSON: message id, text snippet (no full content)
  created_at  BIGINT NOT NULL
);

CREATE INDEX idx_audit_log_created ON audit_log (created_at);
```

---

## Role examples

| Role | read_mode | read_labels | can_send | write_chat_types | write_labels |
|------|-----------|-------------|----------|-----------------|--------------|
| `read-all` | all | — | 0 | — | — |
| `read-work` | whitelist | ["work"] | 0 | — | — |
| `no-personal` | blacklist | ["personal"] | 0 | — | — |
| `dm-assistant` | all | — | 1 | ["user"] | — |
| `work-assistant` | whitelist | ["work"] | 1 | — | null (inherit) |
| `full` | all | — | 1+edit+delete+forward | — | — |

Roles are composable — any combination of read mode + write permissions + write scope is valid.

---

## Security

### 1. Token hashing

Raw tokens are never stored. On `create_token`:
1. Generate 32 random bytes → hex string (64 chars). This is the raw token.
2. Compute `SHA-256(raw_token)` → store the hash in `agent_tokens.token_hash`.
3. Return the raw token to the owner once. It cannot be recovered.

On every request:
```
incoming token → SHA-256 → lookup token_hash in DB
```

If Neon is breached, hashes are exposed but raw tokens are not. SHA-256 is sufficient here because tokens are high-entropy random strings (not passwords), so rainbow tables don't apply.

### 2. Token transport — Authorization header

Agent tokens are sent via `Authorization: Bearer <token>` header, not query params. Query params appear in Cloudflare logs and URL history. MCP config uses the URL for the endpoint only:

```
MCP endpoint: https://tg-reader.ddohne.workers.dev/mcp?account_id=7926042351
Authorization: Bearer <raw_token>
```

`account_id` in the URL is not sensitive — it's a Telegram numeric ID, not a credential. Only the token is secret, and it travels in the header. `MASTER_TOKEN` and `INGEST_TOKEN` remain as Cloudflare secrets (env vars), never in URLs.

### 3. Token expiry

`expires_at` is optional per token. `NULL` = no expiry (for permanent agent integrations). Set a value for time-limited access (e.g. a contractor, a temporary agent). Worker checks `expires_at <= now()` on every request and returns 401 if expired.

No complexity on renewal — just revoke and issue a new token.

### 4. Audit log with configurable retention

Write operations (send/edit/delete/forward) are logged to `audit_log` with token, account, action, and target chat. No message content — only metadata (chat_id, message_id, action type).

Audit log only records write operations (send/edit/delete/forward) — not reads. Volume is tiny: even 100 writes/day for a year is ~36k rows. No meaningful storage concern.

Retention configured via `global_config`:
```sql
INSERT INTO global_config (account_id, key, value)
VALUES ('global', 'audit_log_retention_days', '90');
```

The existing daily cron (already runs at 03:00 UTC) deletes old audit rows:
```sql
DELETE FROM audit_log
WHERE created_at < EXTRACT(EPOCH FROM NOW())::BIGINT - (retention_days * 86400)
```

Set to 0 to disable logging entirely. Default: 90 days.

### 5. MASTER_TOKEN separation

`INGEST_TOKEN` — used by GramJS on Fly.io. Anyone with Fly access can read it.
`MASTER_TOKEN` — separate Cloudflare secret, never leaves the Worker. Not on Fly.

If GramJS is compromised, the attacker gets `INGEST_TOKEN` — they can push messages but cannot create tokens, change roles, or read the archive.

### 6. Whitelist/blacklist scope safety

Ambiguity in whitelist mode is dangerous. Rules:

- `read_mode = 'all'` → `read_labels` and `read_chat_ids` are ignored. Full read access.
- `read_mode = 'whitelist'` → `read_labels` OR `read_chat_ids` must be non-empty. An empty whitelist with no entries is rejected at `create_role` time — it would silently grant access to nothing, which is a misconfiguration not a valid role.
- `read_mode = 'blacklist'` → `read_labels` OR `read_chat_ids` must be non-empty. An empty blacklist is also rejected — it's equivalent to `read_mode = 'all'` and should be expressed that way.

`null` on `read_labels`/`read_chat_ids` in whitelist/blacklist mode → validation error at creation. Never silently falls through to a different behaviour.

---

## Process flow

### Initial setup (owner, once)

```
Owner talks to Claude with MASTER_TOKEN
  → "create a role called work-assistant:
      read only work-labeled chats,
      can send to work-labeled chats,
      no edit or delete"

Claude calls create_role → role created

Owner: "create a token for my work Claude, use work-assistant role,
        for account 7926042351"
Claude calls create_token → raw token returned (shown once)

Owner copies token → sets as Authorization header in work Claude's MCP config
```

### Agent session (scoped agent)

```
Work Claude connects to /mcp?account_id=7926042351
  Authorization: Bearer <work_token>

Worker:
  1. SHA-256(token) → lookup token_hash → get token row
  2. Check expires_at
  3. Lookup token_account_roles for (token_id, account_id) → get role
  4. On every read: inject scope into SQL WHERE clause
  5. On every write: check permissions + scope, log to audit_log
  6. Return 403 with actionable message if out of scope

Agent sees only work chats — cannot access others even by direct chat_id
```

### Permission denied response

```json
{
  "error": "permission_denied",
  "message": "This token cannot send to supergroup chats. Allowed: user, group.",
  "action": "send",
  "target_chat_type": "supergroup"
}
```

### Revoking access

```
Owner: "revoke the work Claude token"
Claude calls list_tokens → finds by label
Claude calls revoke_token → row deleted, audit_log rows preserved (token_id SET NULL)
```

Instant — next request returns 401.

---

## MCP management tools (MASTER_TOKEN only)

### `create_role`
```
name: string
read_mode: "all" | "whitelist" | "blacklist"
read_labels?: string[]       -- required if whitelist/blacklist
read_chat_ids?: string[]     -- alternative to read_labels
can_send?: boolean
can_edit?: boolean
can_delete?: boolean
can_forward?: boolean
write_chat_types?: ("user"|"group"|"supergroup"|"channel")[]
write_labels?: string[]
write_chat_ids?: string[]
```
Validates that whitelist/blacklist roles have at least one filter entry.

### `list_roles`
All roles with full config and token count using each.

### `update_role`
Change any field. Affects all tokens using it instantly.

### `delete_role`
Fails if any tokens still reference it.

### `create_token`
```
label: string
role: string        -- role name
account_id: string  -- account to grant access to (repeat to add more)
expires_at?: number -- optional Unix epoch seconds
```
Returns raw token once. Not stored.

### `list_tokens`
All tokens with label, role, accounts, expires_at. Never the raw token or hash.

### `revoke_token`
Hard delete. Audit log rows retained with token_id set to null.

### `whoami`
Available to scoped agents. Returns their role name, read scope, and which write actions are permitted. Agents call this at session start to self-describe capabilities.

---

## Enforcement — read scope (SQL level)

A whitelist agent cannot receive out-of-scope data even with a direct chat_id request.

```sql
-- whitelist by label
AND m.tg_chat_id IN (
  SELECT cc.tg_chat_id FROM chat_config cc
  WHERE cc.account_id = $1 AND cc.label = ANY($read_labels::text[])
)

-- blacklist by label
AND m.tg_chat_id NOT IN (
  SELECT cc.tg_chat_id FROM chat_config cc
  WHERE cc.account_id = $1 AND cc.label = ANY($read_labels::text[])
)

-- whitelist by chat_id (no join needed)
AND m.tg_chat_id = ANY($read_chat_ids::text[])
```

`read_mode = 'all'` → no clause injected.

---

## Enforcement — write scope

Before queuing any outbox/action item:
1. Is `can_send/edit/delete/forward` true for this role?
2. Resolve target chat's type and label from messages/chat_config.
3. Check `write_chat_types`, `write_labels`, `write_chat_ids` if set.
4. All active conditions must pass.
5. On success: execute + write to `audit_log`.
6. On failure: return permission_denied with specifics.

If `write_*` fields are null, inherit read scope.

---

## Open questions

1. **Rate limiting per token** — prevent mass-sending from a write-capable token. Revisit before issuing write tokens in production.
