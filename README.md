# tg-reader

Personal Telegram message archive. Captures all messages (sent + received) into a searchable database, and lets you send messages via REST API or AI agent.

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
│  │  • Polls /outbox/due + /actions/pending every 30s       │   │
│  │  • pts state → /data/state.json (persistent volume)     │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                            │                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Backfill scripts  (one-time, run manually)             │   │
│  │  getHistory() per dialog → POST /ingest in batches      │   │
│  └────────────────────────┬────────────────────────────────┘   │
└───────────────────────────┼─────────────────────────────────────┘
                            │ REST API (X-Ingest-Token)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│               Cloudflare Worker  (Workers Paid)                  │
│                                                                  │
│   POST /ingest              ← GramJS / backfill                 │
│   GET  /search              ← keyword, chat, sender, date       │
│   GET  /contacts            ← contacts with message counts      │
│   GET  /chats               ← chats with sync status + label    │
│   GET|POST /config          ← global sync_mode                  │
│   GET|POST|DELETE /chats/config  ← per-chat overrides + labels  │
│   POST|GET /outbox          ← write queue (send/draft/scheduled)│
│   POST /actions/edit|delete|forward  ← pending actions          │
│   POST /mcp                 ← MCP server for AI agents          │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
              ┌─────────────────────┴──────────────────┐
              ▼                                         ▼
┌─────────────────────────┐             ┌──────────────────────────┐
│  Neon PostgreSQL         │             │  Cloudflare R2           │
│  (serverless, $0–19/mo) │             │  tg-archive-backups      │
│                          │             │  (private, 30-day TTL)   │
│  messages                │             │  backups/YYYY-MM-DD      │
│  chat_config             │             │  .ndjson                 │
│  global_config           │             └──────────────────────────┘
│  contacts                │
│  backfill_state          │
│  outbox                  │
│  outbox_recipients       │
│  pending_actions         │
└──────────────────────────┘
```

## Stack

| Component | Technology | Cost |
|-----------|-----------|------|
| Message listener + writer | GramJS (npm: `telegram`) on Fly.io | ~$4/mo |
| API + MCP server | Cloudflare Workers Paid | $5/mo |
| Database | Neon PostgreSQL (serverless) | $0–19/mo |
| Backups | Cloudflare R2 | ~$0/mo |

## Sync modes

Control what gets captured via `POST /config`:

| Mode | Behaviour |
|------|-----------|
| `all` | Capture everything (default) |
| `blacklist` | Capture everything except excluded chats |
| `whitelist` | Capture only included chats |
| `none` | Pause all capture |

Per-chat overrides and labels via `POST /chats/config`.

## AI / MCP

Connect Claude (or any MCP-compatible agent) directly to your archive:

```
https://<worker>/mcp?token=<ingest-token>&account_id=<account-id>
```

Add as a custom connector in **claude.ai → Settings → Connectors**. Claude can search your full message history, send messages, edit/delete/forward, draft and schedule — just by asking.

See [docs/agents.md](docs/agents.md) for setup and usage examples.

## Search API

```
GET /search?q=keyword
GET /search?chat_id=xxx&from=1704067200&to=1719792000
GET /search?q=keyword&limit=20&before_id=12345&before_sent_at=1704067200
```

All timestamps are Unix epoch seconds. Full-text search powered by PostgreSQL GIN index.

## Repo structure

```
/
├── worker/        Cloudflare Worker (TypeScript)
├── gramjs/        GramJS listener + backfill scripts (TypeScript)
│   └── src/
│       ├── auth.ts          one-time auth → prints StringSession
│       ├── listener.ts      live capture + outbox/actions polling
│       ├── backfill-seed.ts enumerate dialogs → backfill_state
│       └── backfill-run.ts  paginated getHistory() → /ingest
├── schema.sql     PostgreSQL schema (single source of truth)
├── SPEC.md        Full functional specification
└── CLAUDE.md      Agent conventions and constraints
```

## Setup

See [docs/](docs/) for full documentation.

**Quick start order:**
1. Create Neon database, apply `schema.sql`
2. Deploy Cloudflare Worker with `DATABASE_URL` secret
3. Run `gramjs/src/auth.ts` locally → set `fly secrets set GRAMJS_SESSION=...`
4. Deploy GramJS to Fly.io
5. Run backfill scripts (after 1–2 days of live capture)
