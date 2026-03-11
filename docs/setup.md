# Setup

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) (Workers Paid plan, $5/mo)
- [Fly.io account](https://fly.io) (~$4/mo)
- [Telegram API credentials](https://my.telegram.org/apps) (your own app — never shared credentials)
- Node.js 20+, npm, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/), [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/)

---

## Step 1 — Cloudflare setup

### Create D1 database

```bash
wrangler d1 create tg-archive
```

Copy the `database_id` into `worker/wrangler.toml`.

### Apply schema

```bash
wrangler d1 execute tg-archive --remote --file=schema.sql
```

### Deploy the Worker

```bash
cd worker
npm install
wrangler deploy
```

### Set the ingest token secret

```bash
wrangler secret put INGEST_TOKEN
# enter a long random string — keep it, you'll need it for Fly
```

Note your Worker URL (e.g. `https://tg-reader.<your-subdomain>.workers.dev`).

---

## Step 2 — Telegram session

```bash
cd gramjs
cp .env.example .env
# fill in API_ID, API_HASH, INGEST_TOKEN, WORKER_URL
npm install
npx ts-node src/auth.ts
```

Follow the prompts (phone number → code → 2FA if enabled). Copy the `GRAMJS_SESSION` string that's printed.

---

## Step 3 — Fly.io deployment

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

## Step 4 — Backfill historical messages

See [Backfill](backfill.md).

---

## GitHub Actions (auto-deploy)

Add these secrets to your GitHub repo (`Settings → Secrets → Actions`):

| Secret | How to get |
|--------|-----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Edit Workers template |
| `FLY_API_TOKEN` | `fly tokens create deploy -a tg-reader` |

Every push to `main` will automatically deploy the Worker and the listener.
