# Setup

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) (Workers Paid plan, $5/mo)
- [Neon account](https://neon.tech) (serverless PostgreSQL, $0–19/mo)
- [Fly.io account](https://fly.io) (~$4/mo)
- [Telegram API credentials](https://my.telegram.org/apps) (your own app — never shared credentials)
- Node.js 20+, npm, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/), [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/)

---

## Step 1 — Neon database

1. Create a project at [neon.tech](https://neon.tech)
2. Copy the **connection string** (PostgreSQL URL) from the dashboard
3. Apply the schema:

```bash
psql $DATABASE_URL -f schema.sql
```

The schema is fully idempotent — safe to re-run at any time to apply new tables or indexes.

---

## Step 2 — Cloudflare Worker

### Deploy

```bash
cd worker
npm install
wrangler deploy
```

### Set secrets

```bash
wrangler secret put INGEST_TOKEN   # pick a strong random string — keep it for Fly
wrangler secret put DATABASE_URL   # paste your Neon connection string
```

Note your Worker URL (e.g. `https://tg-reader.<your-subdomain>.workers.dev`).

---

## Step 3 — Telegram session

Run this **locally from your home IP** — Telegram flags logins from datacenter IPs:

```bash
cd gramjs
cp .env.example .env
# fill in: API_ID, API_HASH, INGEST_TOKEN, WORKER_URL
npm install
npx ts-node src/auth.ts
```

Follow the prompts (phone number → code → 2FA if enabled). Copy the `GRAMJS_SESSION` string that's printed.

---

## Step 4 — Fly.io deployment

```bash
fly launch --name tg-reader --no-deploy
fly volumes create tg_state --region ams --size 1
fly secrets set \
  GRAMJS_SESSION=<session> \
  API_ID=<id> \
  API_HASH=<hash> \
  INGEST_TOKEN=<token> \
  WORKER_URL=<worker-url>
fly deploy
```

Check it's running:

```bash
fly logs -a tg-reader
# should see: [listener] connected to Telegram
```

---

## Step 5 — Backfill historical messages

See [Backfill](backfill.md). Wait 1–2 days before running backfill.

---

## Environment variables reference

### Worker (Cloudflare secrets)

| Secret | Description |
|--------|-------------|
| `INGEST_TOKEN` | Shared auth token for all endpoints |
| `DATABASE_URL` | Neon PostgreSQL connection string |

### GramJS (Fly secrets)

| Secret | Description |
|--------|-------------|
| `GRAMJS_SESSION` | StringSession from `auth.ts` |
| `API_ID` | Telegram app ID from my.telegram.org |
| `API_HASH` | Telegram app hash from my.telegram.org |
| `INGEST_TOKEN` | Same token as Worker |
| `WORKER_URL` | Full Worker URL, no trailing slash |
| `ACCOUNT_ID` | Optional — defaults to your Telegram user ID |

---

## GitHub Actions (auto-deploy)

Add these secrets to your GitHub repo (`Settings → Secrets → Actions`):

| Secret | How to get |
|--------|-----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Edit Workers template |
| `FLY_API_TOKEN` | `fly tokens create deploy -a tg-reader` |

Every push to `main` will automatically deploy the Worker and the listener.
