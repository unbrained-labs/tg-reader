# Deploy

## 1. Neon database

1. Create a project at [neon.tech](https://neon.tech)
2. Copy the connection string (PostgreSQL URL)
3. Apply the schema:

```bash
psql $DATABASE_URL -f schema.sql
```

## 2. Cloudflare Worker

```bash
cd worker
npm install
wrangler secret put INGEST_TOKEN        # pick a strong random string
wrangler secret put DATABASE_URL        # paste Neon connection string
wrangler deploy
```

Note the Worker URL from deploy output.

## 3. Telegram session (run locally, home IP)

```bash
cd gramjs
cp .env.example .env                    # fill in API_ID and API_HASH from my.telegram.org/apps
npm install
npx ts-node src/auth.ts                 # follow prompts, copy the printed session string
```

## 4. Fly.io

```bash
fly auth login
fly apps create tg-reader
fly volumes create tg_state --size 1 --region ams -a tg-reader
fly secrets set \
  GRAMJS_SESSION="<session from step 3>" \
  API_ID="<your api id>" \
  API_HASH="<your api hash>" \
  INGEST_TOKEN="<same token as Worker>" \
  WORKER_URL="<worker url from step 2>" \
  -a tg-reader
fly deploy
```

## 5. Verify

```bash
WORKER_URL=<url> INGEST_TOKEN=<token> bash scripts/e2e-verify.sh
```

All green → send yourself a Telegram message, wait 10s, check it landed:

```bash
psql $DATABASE_URL -c \
  "SELECT tg_message_id, direction, sent_at FROM messages ORDER BY indexed_at DESC LIMIT 5"
```

## 6. Backfill (after 1–2 days of live capture)

```bash
cd gramjs
npx ts-node src/backfill-seed.ts   # enumerate dialogs → seeds backfill_state
npx ts-node src/backfill-run.ts    # fetch history — runs overnight, resumable
```

Monitor:

```bash
psql $DATABASE_URL -c \
  "SELECT status, COUNT(*) FROM backfill_state GROUP BY status"
```
