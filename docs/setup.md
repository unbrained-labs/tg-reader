# Setup

## Before you start

### Accounts you need

- [Cloudflare account](https://dash.cloudflare.com) (Workers Paid plan, $5/mo — required for cron triggers and R2 backups)
- [Neon account](https://neon.tech) (serverless PostgreSQL, $0–19/mo — free tier ~500 MB)
- [Fly.io account](https://fly.io) (~$4/mo for one shared VM)
- Telegram API credentials (free — see below)

### CLIs to install

```bash
node --version       # must be 20+
npm --version        # bundled with Node.js
neonctl --version    # npm install -g neonctl
wrangler --version   # npm install -g wrangler
flyctl version       # https://fly.io/docs/hands-on/install-flyctl/
```

Authenticate each CLI once:

```bash
neonctl auth
npx wrangler login
flyctl auth login
```

### Getting your Telegram API_ID / API_HASH

You must create your own Telegram application to get these credentials. Do not use credentials shared by others — Telegram ties sessions to the originating app.

1. Go to [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. Log in with your Telegram phone number (you will receive a code via SMS or app)
3. Fill in the **Create new application** form — the name and description can be anything (e.g. "My Archive")
4. Click **Create application**
5. Copy the **App api_id** (a number, e.g. `12345678`) and **App api_hash** (a 32-character hex string)

> **Security note:** These credentials bind your session to your app. Never share them, never commit them to source control, and never use credentials from someone else's app. If they are compromised, revoke them on the same page and generate new ones.

---

## Automated setup (recommended)

One command bootstraps the entire stack — Neon database, Cloudflare Worker, Telegram auth, and Fly.io listener:

```bash
npm install && npm run setup
```

The script walks you through seven phases interactively:

| Phase | What it does |
|-------|-------------|
| **preflight** | Checks `neonctl`, `wrangler`, `flyctl`, Node ≥ 20 are installed and authed |
| **telegram-creds** | Prompts for API_ID, API_HASH and your phone number |
| **telegram-auth** | Runs the GramJS auth flow, saves the session string |
| **neon** | Creates a Neon project, fetches the connection string, applies `schema.sql` |
| **worker** | Generates tokens, updates `wrangler.toml`, sets secrets, deploys the Worker |
| **fly** | Creates the Fly app + volume, sets secrets, deploys the GramJS listener |
| **mcp** | Mints an agent token and prints the final MCP URL + `claude mcp add` command |

Progress is saved to `.setup-state.json` after each phase — re-run the script at any time to resume from where you left off. To re-run a single phase:

```bash
npm run setup -- --phase <phase-name>
```

---

## Manual setup (fallback)

The steps below replicate what the automated script does. Follow these if you prefer manual control or if the script encounters an issue you can't resolve.


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

Note your Worker URL (e.g. `https://<your-app-name>.<your-subdomain>.workers.dev`).

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
fly launch --name <your-app-name> --no-deploy
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
fly logs -a <your-app-name>
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

## Dashboard (optional) {#dashboard}

A lightweight browser dashboard ships in `frontend/`. It connects directly to your Worker and provides five screens: overview stats, message search, chats, contacts, and backfill progress.

**Stack:** Preact + Vite — ~29KB JS, ~9KB CSS. No extra backend or hosting needed.

### Build and deploy

```bash
cd frontend
npm install
npm run build      # outputs built assets to worker/public/
cd ../worker
wrangler deploy    # redeploy Worker — static assets are included automatically
```

The Worker's `wrangler.toml` already has `[assets] directory = "./public"` configured. Static files are served before the Worker script runs, so they bypass auth entirely — only the API routes remain protected.

### Access

Open your Worker URL in a browser (`https://<name>.workers.dev`). You'll see a login screen — enter:

- **Worker URL** — your Worker's full URL
- **Ingest Token** — your `INGEST_TOKEN` secret
- **Account ID** — optional, defaults to `primary`

Credentials are saved to `localStorage`; click **out** in the sidebar to clear them.

### Local development

```bash
cd frontend
npm run dev    # http://localhost:5173 — point login form at your deployed Worker
```

---

## GitHub Actions (auto-deploy)

Add these secrets to your GitHub repo (`Settings → Secrets → Actions`):

| Secret | How to get |
|--------|-----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Edit Workers template |
| `FLY_API_TOKEN` | `fly tokens create deploy -a <your-app-name>` |

Every push to `main` will automatically deploy the Worker and the listener.
