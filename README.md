# tg-reader

Personal Telegram message archive. Captures all messages (sent + received) into a searchable database.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Telegram                                 │
│              (your account — DMs, groups, channels)             │
└───────────────────────────┬─────────────────────────────────────┘
                            │ MTProto (real-time events)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Fly.io  (~$4/mo)                            │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  GramJS listener  (Node.js / TypeScript)                │   │
│  │                                                          │   │
│  │  • NewMessage → sync check → batch buffer               │   │
│  │  • On startup: getDifference() gap recovery             │   │
│  │  • pts state → /data/state.json (persistent volume)     │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                            │                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Backfill script  (one-time, run manually)              │   │
│  │  getHistory() per dialog → POST /ingest in batches      │   │
│  └────────────────────────┬────────────────────────────────┘   │
└───────────────────────────┼─────────────────────────────────────┘
                            │ POST /ingest  (X-Ingest-Token)
                            │ batches of up to 100 messages
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│               Cloudflare Worker  (Workers Paid)                  │
│                                                                  │
│   POST /ingest              ← GramJS / backfill                 │
│   GET  /search              ← keyword, chat, sender, date       │
│   GET  /contacts            ← distinct senders + counts         │
│   GET  /chats               ← distinct chats + sync status      │
│   GET|POST /config          ← sync_mode global setting          │
│   GET|POST|DELETE /chats/config  ← per-chat overrides           │
└───────────┬───────────────────────────────────┬─────────────────┘
            │ D1 reads/writes                   │ R2 writes
            │                                   │ (daily backup cron)
            ▼                                   ▼
┌───────────────────────┐           ┌───────────────────────────┐
│   Cloudflare D1       │           │   Cloudflare R2           │
│   (SQLite + FTS5)     │           │   tg-archive-backups      │
│                       │           │   (private, 30-day TTL)   │
│   messages            │           │   backups/YYYY-MM-DD      │
│   messages_fts        │           │   .ndjson                 │
│   chat_config         │           └───────────────────────────┘
│   global_config       │
│   backfill_state      │
└───────────────────────┘
```

## Stack

| Component | Technology | Cost |
|-----------|-----------|------|
| Message listener | GramJS (npm: `telegram`) on Fly.io | ~$4/mo |
| API + ingest | Cloudflare Workers Paid | $5/mo |
| Database | Cloudflare D1 (SQLite + FTS5) | included |
| Backups | Cloudflare R2 | ~$0/mo |
| Secrets | Fly secrets (session + token) | included |

## Sync modes

Control what gets captured via `POST /config`:

| Mode | Behaviour |
|------|-----------|
| `all` | Capture everything (default) |
| `blacklist` | Capture everything except excluded chats |
| `whitelist` | Capture only included chats |
| `none` | Pause all capture |

Per-chat overrides via `POST /chats/config`.

## Search API

```
GET /search?q=keyword
GET /search?chat_id=xxx&from=1704067200&to=1719792000
GET /search?q=keyword&chat_id=xxx&limit=50&offset=0
```

All timestamps are Unix epoch seconds. Full-text search powered by FTS5.

## Repo structure

```
/
├── worker/        Cloudflare Worker (TypeScript)
├── gramjs/        GramJS listener + backfill scripts (TypeScript)
│   └── src/
│       ├── auth.ts          one-time auth → prints StringSession
│       ├── listener.ts      live message capture
│       ├── backfill-seed.ts enumerate dialogs → backfill_state
│       └── backfill-run.ts  paginated getHistory() → /ingest
├── schema.sql     D1 schema (single source of truth)
├── SPEC.md        Full functional specification
└── CLAUDE.md      Agent conventions and constraints
```

## Setup

See [SPEC.md](./SPEC.md) for full setup instructions and [CLAUDE.md](./CLAUDE.md) for development conventions.

**Quick start order:**
1. Create D1 database + apply `schema.sql`
2. Deploy Cloudflare Worker
3. Run `gramjs/src/auth.ts` locally → set `fly secrets set GRAMJS_SESSION=...`
4. Deploy GramJS to Fly.io
5. Run backfill scripts
