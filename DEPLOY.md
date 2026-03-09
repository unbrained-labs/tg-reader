# Deploy

## 1. Cloudflare Worker

```bash
wrangler d1 create tg-archive
# → paste database_id into worker/wrangler.toml

wrangler d1 execute tg-archive --file=schema.sql
wrangler secret put INGEST_TOKEN        # pick a strong random string
cd worker && wrangler deploy
```

Note the Worker URL from deploy output.

## 2. Telegram session (run locally, home IP)

```bash
cd gramjs
cp .env.example .env                    # fill in API_ID and API_HASH from my.telegram.org/apps
npx ts-node src/auth.ts                 # follow prompts, copy the printed session string
```

## 3. Fly.io

```bash
fly auth login
fly apps create tg-reader
fly volumes create tg_state --size 1 --region ams -a tg-reader
fly secrets set \
  GRAMJS_SESSION="<session from step 2>" \
  API_ID="<your api id>" \
  API_HASH="<your api hash>" \
  INGEST_TOKEN="<same token as Worker>" \
  WORKER_URL="<worker url from step 1>" \
  -a tg-reader
fly deploy
```

## 4. Verify

```bash
WORKER_URL=<url> INGEST_TOKEN=<token> bash scripts/e2e-verify.sh
```

All green → send yourself a Telegram message, wait 10s, check it landed:

```bash
wrangler d1 execute tg-archive --command \
  "SELECT tg_message_id, direction, sent_at FROM messages ORDER BY indexed_at DESC LIMIT 5"
```

## 5. Backfill (after 1–2 days of live capture)

```bash
cd gramjs
npx ts-node src/backfill-seed.ts   # enumerate dialogs → seeds backfill_state
npx ts-node src/backfill-run.ts    # fetch history — runs overnight, resumable
```

Monitor:
```bash
wrangler d1 execute tg-archive --command \
  "SELECT status, COUNT(*) n FROM backfill_state GROUP BY status"
```
