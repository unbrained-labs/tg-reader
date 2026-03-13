# Observer Jobs — Design Document

## Overview

A job scheduler that launches AI agents on a schedule or trigger. Each job defines when to run, which model to call, what task to give it, and what MCP access it has. The agent does the work via existing MCP tools — no hardcoded actions.

BYOM (Bring Your Own Model) — no lock-in. Any OpenAI-compatible endpoint works.

---

## Architecture

```
Worker cron (every 15 min)
  → evaluate enabled jobs (schedule due OR trigger condition met)
  → for each due job:
      1. build context (triggering message, chat info, timestamp)
      2. POST to model endpoint with system prompt + task + context
      3. agent calls MCP tools using job's scoped token (RBAC enforced)
      4. update last_run_at, write to audit_log
```

The agent is scoped by the same RBAC model as any other agent token — same roles, same enforcement, same audit log. A job's token can be revoked to disable the agent without deleting the job definition.

---

## Schema

```sql
CREATE TABLE jobs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     TEXT NOT NULL,
  name           TEXT NOT NULL,

  enabled        SMALLINT NOT NULL DEFAULT 1,

  -- Trigger: schedule, condition, or both
  schedule       TEXT,           -- cron expression e.g. "0 8 * * *" (optional)
  trigger_type   TEXT,           -- 'new_message' | 'keyword' | 'unanswered' (optional)
  trigger_config TEXT,           -- JSON, depends on trigger_type

  -- Model (BYOM)
  model_config   TEXT NOT NULL,  -- JSON: { provider, model, endpoint?, api_key_ref }

  -- Task
  task_prompt    TEXT NOT NULL,  -- instructions for the agent, supports {variables}

  -- Access (RBAC)
  token_id       BIGINT REFERENCES agent_tokens(id) ON DELETE SET NULL,
  -- null token = job disabled until a token is assigned

  -- State
  last_run_at    BIGINT,
  cooldown_secs  INTEGER NOT NULL DEFAULT 3600,  -- min gap between runs, prevents spam

  created_at     BIGINT NOT NULL
);
```

---

## Model config (BYOM)

Stored as JSON in `model_config`. `api_key_ref` points to a Cloudflare secret name — the key never touches the DB.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "api_key_ref": "ANTHROPIC_KEY"
}
```

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "api_key_ref": "OPENAI_KEY",
  "endpoint": "https://api.openai.com/v1/chat/completions"
}
```

```json
{
  "provider": "openai",
  "model": "llama-3",
  "endpoint": "https://your-local-endpoint/v1/chat/completions",
  "api_key_ref": "LOCAL_KEY"
}
```

Any OpenAI-compatible endpoint works. Swap model by updating `model_config` — no code changes.

---

## Trigger types

### Schedule only
```json
{ "schedule": "0 8 * * *" }
```
Fires at 08:00 UTC daily. No message context injected.

### Condition only
```json
{
  "trigger_type": "new_message",
  "trigger_config": { "label": "clients" }
}
```
Fires when a new message arrives in any client-labeled chat since last check.

### Both (schedule + condition gate)
```json
{
  "schedule": "*/15 * * * *",
  "trigger_type": "unanswered",
  "trigger_config": { "label": "clients", "hours": 2 }
}
```
Checks every 15 min, but only fires when a client chat has been unanswered for 2+ hours.

### Trigger config by type

| trigger_type | config fields |
|---|---|
| `new_message` | `chat_id?`, `label?`, `chat_type?` |
| `keyword` | `keywords: string[]`, `chat_id?`, `label?` |
| `unanswered` | `hours: number`, `chat_id?`, `label?` |

---

## Task prompt variables

The Worker injects context before calling the model:

| Variable | Value |
|---|---|
| `{chat_name}` | Name of the triggering chat |
| `{chat_id}` | tg_chat_id of the triggering chat |
| `{sender}` | Sender name/username |
| `{snippet}` | First 300 chars of the triggering message |
| `{timestamp}` | ISO 8601 time of the trigger |
| `{account_id}` | The archive account being observed |

For schedule-only jobs, message variables are empty — the agent uses MCP tools to fetch what it needs.

**Examples:**

```
You are a personal assistant for a Telegram archive.
Summarize all unread messages from work-labeled chats in the last 24 hours.
Send the summary to Saved Messages. Be concise — bullet points per chat.
```

```
A new message arrived in {chat_name} from {sender} at {timestamp}:
"{snippet}"

Draft a professional support reply and send it to {chat_id}.
If you need more context, read the recent history first.
```

```
Check if any client chat has been unanswered for over 2 hours.
For each one found, send me a reminder in Saved Messages with the chat name
and the last message received.
```

---

## RBAC integration

Each job has a `token_id` pointing to a standard agent token with a role. Same system as any other agent — no special cases.

```
Job: "client digest"
  token → role: "read-work"
    read_mode: whitelist
    read_labels: ["clients"]
    can_send: 1
    write_chat_types: ["user"]  -- can only notify me via DM
```

The agent launched by this job can only read client-labeled chats and send to DMs. If it tries to read a personal chat or send to a group, the MCP layer returns `permission_denied`.

Revoke the token → job is effectively disabled without losing its definition.

---

## Execution detail

```ts
// Worker cron handler
async function runJobs(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const dueJobs = await getDueJobs(env, now);

  for (const job of dueJobs) {
    const context = await buildContext(job, env);
    const prompt = interpolate(job.task_prompt, context);
    const apiKey = env[job.model_config.api_key_ref]; // Cloudflare secret

    await callModel(job.model_config, prompt, job.token_id, env);
    await markJobRun(job.id, now, env);
  }
}
```

The model call includes the MCP endpoint URL + the job's token in the system prompt or tool config, so the agent can call back into the archive.

---

## MCP management tools

Managed via Claude with `MASTER_TOKEN`, same as roles and tokens.

### `create_job`
```
name: string
schedule?: string           -- cron expression
trigger_type?: string
trigger_config?: object
model_config: object        -- provider, model, api_key_ref
task_prompt: string
role: string                -- role name to create a token for this job
cooldown_secs?: number      -- default 3600
```
Creates the job and auto-creates a scoped token for it.

### `list_jobs`
All jobs with name, enabled status, schedule, trigger, last_run_at (ISO), token label.

### `toggle_job`
Enable or disable by name. Does not revoke the token.

### `delete_job`
Deletes the job. Optionally revokes the associated token.

### `update_job`
Update prompt, schedule, trigger, model config, or cooldown.

---

## Operational notes

- **Cooldown** prevents the same job firing on every cron tick once triggered. Default 1 hour. Set higher for noisy chats.
- **No token = no run** — a job with `token_id = null` is skipped silently.
- **Audit log** — all actions the job's agent takes are logged via the standard write audit (token_id tracked).
- **Model failures** — if the model call fails (timeout, API error), log the error and continue. Do not retry in the same cron tick.
- **Cost awareness** — each job invocation = one model API call. For high-frequency triggers on active chats, set a long cooldown or the costs add up.
