# Agent Permissions — Design Document

## Overview

tg-reader supports multiple AI agents accessing the same Telegram archive with different permission levels. Each agent gets its own token scoped to a role that defines what it can read and what it can write.

The ingest token (`INGEST_TOKEN`) is separate — used only by GramJS (listener, backfill). Never exposed to agents.

---

## Architecture

```
INGEST_TOKEN (GramJS only)
  → /ingest, /backfill/*, /contacts, /deleted

Agent Token (AI agents)
  → /mcp?token=<agent_token>&account_id=<id>
  → read scope enforced on all queries
  → write permissions checked before any mutation
```

Master token (full access, stored as Cloudflare secret) bypasses role checks. Used by the owner to manage roles and tokens via Claude.

---

## Schema

```sql
CREATE TABLE roles (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,

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
  write_chat_ids   TEXT,   -- JSON array of tg_chat_ids

  UNIQUE (account_id, name)
);

CREATE TABLE agent_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  label       TEXT,        -- human-readable: "work claude", "read-only scout"
  created_at  BIGINT NOT NULL
);
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

## Process flow

### Initial setup (owner, once)

```
Owner talks to Claude with master token
  → "create a role called work-assistant:
      read only work-labeled chats,
      can send to work-labeled chats,
      no edit or delete"

Claude calls create_role MCP tool
  → role created, id returned

Owner: "create a token for my work Claude, use work-assistant role"
Claude calls create_token MCP tool
  → token string returned (shown once, never stored in plaintext)

Owner copies token → configures work Claude's MCP settings
```

### Agent session (scoped agent)

```
Work Claude connects: /mcp?token=<work_token>&account_id=<id>

Worker:
  1. Looks up token → gets role
  2. On every read query: injects WHERE label = 'work' (or equivalent)
  3. On every write: checks can_send, validates target chat is in scope
  4. Returns 403 with clear message if out of scope

Agent sees only work chats — can't request others even by chat_id
```

### Permission denied UX

```json
{
  "error": "permission_denied",
  "message": "This token cannot send to supergroup chats. Allowed: user, group.",
  "action": "send",
  "target_chat_type": "supergroup"
}
```

Agent gets a clear, actionable error — not a generic 403.

### Revoking access

```
Owner: "revoke the work Claude token"
Claude calls list_tokens → finds token by label
Claude calls revoke_token → hard delete
```

Instant — next request from that token gets 401.

---

## MCP management tools (master token only)

### `create_role`
```
name: string
read_mode: "all" | "whitelist" | "blacklist"
read_labels?: string[]
read_chat_ids?: string[]
can_send?: boolean
can_edit?: boolean
can_delete?: boolean
can_forward?: boolean
write_chat_types?: ("user"|"group"|"supergroup"|"channel")[]
write_labels?: string[]
write_chat_ids?: string[]
```

### `list_roles`
Returns all roles with their full config and how many tokens use each.

### `update_role`
Change any field on a role by name. Affects all tokens using it instantly.

### `delete_role`
Fails if any tokens are still using the role (must revoke them first).

### `create_token`
```
label: string        -- "work claude", "read-only assistant"
role: string         -- role name
```
Returns token string. Shown once — owner must copy it immediately.

### `list_tokens`
Returns all active tokens with label, role name, created_at. Never returns the token string.

### `revoke_token`
```
label: string   -- or id
```
Hard deletes the token row. Instant effect.

---

## Enforcement — read scope

Read scope is enforced at the SQL level, not application level. A whitelist agent cannot receive data from out-of-scope chats even if it constructs a request with an arbitrary chat_id.

Implementation: before any SELECT, inject scope conditions into the WHERE clause based on the resolved role. If `read_mode = whitelist` and `read_labels = ["work"]`, every query gets:

```sql
AND m.tg_chat_id IN (
  SELECT cc.tg_chat_id FROM chat_config cc
  WHERE cc.account_id = $1 AND cc.label = ANY($labels)
)
```

For `blacklist`, negate it:
```sql
AND m.tg_chat_id NOT IN (...)
```

For `read_chat_ids`, use the array directly without the join.

---

## Enforcement — write scope

Before queuing any outbox/action item, resolve the target chat's type and label, then check:

1. `can_send / can_edit / can_delete / can_forward` — is this action allowed at all?
2. `write_chat_types` — if set, is the target chat's type in the list?
3. `write_labels` — if set, does the target chat have one of those labels?
4. `write_chat_ids` — if set, is the target chat_id explicitly listed?

All active write scope conditions must pass. If `write_*` fields are null, the read scope is inherited.

---

## UX summary

| Who | How they interact |
|-----|------------------|
| Owner | Talks to Claude with master token. Manages roles and tokens via natural language → MCP tools. |
| Scoped agent | Gets a token. Connects to MCP. Discovers its permissions via `stats` or a future `whoami` tool. Operates within scope — clean errors when it hits a boundary. |
| Revocation | Owner says "revoke X" to Claude → instant. No UI needed. |

---

## Open questions

1. **`whoami` / permissions discovery tool** — should scoped agents get a tool that returns their current role and limits? Useful so the agent can self-describe its capabilities at session start.
2. **Audit log** — log writes (send/edit/delete) with token_id so the owner can see what each agent did.
3. **Rate limiting per token** — prevent a scoped agent from mass-sending even if `can_send` is true.
4. **Token expiry** — optional `expires_at` on agent_tokens for time-limited access.
