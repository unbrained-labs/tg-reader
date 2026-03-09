# TG Reader — Project Conventions

## Repo structure
```
/
├── worker/        Cloudflare Worker (TypeScript)
├── gramjs/        GramJS listener + backfill scripts (TypeScript)
├── schema.sql     Single source of truth for D1 schema
└── SPEC.md        Full functional specification
```

## Language & tooling
- TypeScript everywhere (strict mode)
- Package manager: npm
- GramJS npm package: `telegram` (not `gramjs`)
- Worker runtime: Cloudflare Workers (not Node.js — no `process`, `fs`, etc.)
- Node.js target for gramjs: 20 LTS

## TelegramClient init
Always initialise with `floodSleepThreshold: 300` — this makes the client auto-sleep on any FLOOD_WAIT error up to 5 minutes, across all API calls (backfill, gap recovery, entity resolution).

```ts
const client = new TelegramClient(session, apiId, apiHash, {
  floodSleepThreshold: 300,
});
```

## Key constraints (read before writing any code)
- `tg_chat_id` and `sender_id` are always `string` — Telegram IDs are 64-bit, never store as number
- `sent_at` is always Unix epoch **seconds** (integer) — Telegram's native format. Never call `new Date()` on it for storage.
- D1 batch inserts: use `db.batch([stmt, stmt, ...])` with one prepared statement per row. Do NOT use multi-row `INSERT VALUES` — D1 caps at 100 bound parameters per statement.
- FTS5 is in use — do not add a B-tree index on the `text` column.
- `/ingest` endpoint accepts batches up to 100 messages. GramJS must buffer and batch, not send one-by-one.
- All Worker endpoints require `X-Ingest-Token` header — including the config read endpoints used by GramJS on startup.

## Environment variables
### Worker (Cloudflare secrets)
- `INGEST_TOKEN` — shared auth token

### GramJS (Fly secrets)
- `GRAMJS_SESSION` — StringSession from initial auth
- `INGEST_TOKEN` — same shared token
- `WORKER_URL` — full URL of deployed Worker (no trailing slash)

## Backfill anti-ban rules
- Do NOT run backfill immediately after first login — let the session run live for 1-2 days first
- Randomize sleep between pages: `Math.random() * 2500 + 1500` ms (1.5–4s) — fixed intervals look mechanical
- Never run parallel getHistory calls — always serial, one dialog at a time
- If FLOOD_WAIT exceeds 300s, stop the script and resume the next day
- API_ID + API_HASH must be from your own app at my.telegram.org — never shared credentials
- Set realistic device info on TelegramClient (see below)

## TelegramClient init
Always initialise with `floodSleepThreshold: 300` and realistic device info:

```ts
const client = new TelegramClient(session, apiId, apiHash, {
  floodSleepThreshold: 300,
  deviceModel: 'MacBook Pro',
  systemVersion: 'macOS 26.3',
  appVersion: '12.4.2',
  langCode: 'en',
});
```

## Security
- Never log message `text` content — log metadata only (chat_id, message_id, counts, errors)
- R2 backup bucket must be private — never enable public access
- `fly logs` is accessible to anyone with Fly account access — keep logs clean

## Local development
- Worker: `cd worker && wrangler dev --local` (uses local D1)
- GramJS: `cd gramjs && npx ts-node src/listener.ts` (requires .env file with above vars)
- Schema: `wrangler d1 execute tg-archive --local --file=../schema.sql`

## Schema
Single source of truth is `/schema.sql`. Apply with:
```
wrangler d1 execute tg-archive --file=schema.sql          # production
wrangler d1 execute tg-archive --local --file=schema.sql  # local dev
```
