# tg-reader

Personal Telegram message archive. Captures all messages (sent + received) into a searchable database, and lets you send messages via REST API or AI agent.

## ⚠️ Caveats

- This archives **your** full Telegram history into **your own** database. It is not a hosted service — you run and pay for all the infrastructure.
- Does **not** work with Telegram bot accounts. Requires a real user session (MTProto, not the Bot API).
- The `GRAMJS_SESSION` string grants full account access. Treat it like a password: store it only in secret managers, never in source control.
- Bulk-archiving a user session is a gray area under Telegram's Terms of Service. Use at your own risk.

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
| Dashboard UI *(optional)* | Preact + Vite, served as static assets | free |

## Prerequisites & costs

You will need accounts and CLIs for all of the following before you start:

| Requirement | Free tier? | Notes |
|-------------|-----------|-------|
| **Cloudflare account** | Yes (Workers Free) | Workers Paid ($5/mo) required if you use cron triggers, Workers AI, or R2 at any meaningful scale |
| **Neon PostgreSQL** | Yes (~500 MB) | Free tier is enough to get started; upgrade as your archive grows |
| **Fly.io account** | No | ~$4/mo for one shared VM running the GramJS listener |
| **Telegram API credentials** | Free | Visit [my.telegram.org/apps](https://my.telegram.org/apps) to create your own app — see [docs/setup.md](docs/setup.md) |
| **OpenAI / Anthropic API key** | Optional | Only needed for AI insight features; Cloudflare Workers AI binding works without an external key |

**Rough monthly cost: $0–30/mo depending on usage volume and AI features.** A minimal setup (free Neon tier + Fly shared VM + Cloudflare Workers Paid) runs around $9/mo.

**CLIs to install before following the setup guide:**

```bash
npm install -g wrangler          # Cloudflare Workers CLI
brew install flyctl              # Fly.io CLI (or see https://fly.io/docs/hands-on/install-flyctl/)
# Node.js 20+ is also required
```

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

Connect Claude (or any MCP-compatible agent) directly to your archive.

**Recommended — CLI with header-based auth** (token stays out of logs and URLs):

```bash
claude mcp add --transport http tg-reader \
  "https://<worker>/mcp?account_id=<account-id>" \
  --header "Authorization: Bearer <ingest-token>"
```

**claude.ai connector UI** (fallback — the dialog only accepts a URL, so the token goes in the query string and ends up in Cloudflare access logs):

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
├── frontend/      Optional dashboard UI (Preact + Vite)
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
6. *(Optional)* Build and deploy the dashboard UI — see [docs/setup.md#dashboard](docs/setup.md#dashboard)
