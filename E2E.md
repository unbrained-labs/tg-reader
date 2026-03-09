# E2E Test Guide — TG Reader

Run these tests in order after deploying. All 5 must pass before starting full backfill.

## Prerequisites

```bash
export WORKER_URL=https://tg-reader.<account>.workers.dev
export INGEST_TOKEN=<your-ingest-token>
```

---

## Automated: API verification

Runs ~30 checks against every Worker endpoint — auth, ingest, search, config, backfill, contacts.

```bash
bash scripts/e2e-verify.sh
```

Expected: `All API tests passed.`

---

## Test 1 — Live capture

Confirms the GramJS listener is running and messages land in D1.

1. Send a message to **Saved Messages** (your own account) in Telegram
2. Wait 10 seconds
3. Query D1:

```bash
wrangler d1 execute tg-archive --command \
  "SELECT tg_message_id, tg_chat_id, direction, sent_at, text FROM messages ORDER BY indexed_at DESC LIMIT 5"
```

**Pass:** The message appears with `direction=out` and `sent_at` as an integer (Unix seconds, not a date string).

**Troubleshoot if missing:**
- Check Fly logs: `fly logs -a tg-reader`
- Confirm listener is running: `fly status -a tg-reader`
- Verify `WORKER_URL` and `INGEST_TOKEN` secrets match: `fly secrets list -a tg-reader`

---

## Test 2 — FTS5 search

Confirms full-text search works end-to-end.

1. Send a message to Saved Messages with a unique word, e.g. `xqz9test`
2. Wait 10 seconds
3. Call the search endpoint:

```bash
curl -s -H "X-Ingest-Token: $INGEST_TOKEN" \
  "$WORKER_URL/search?q=xqz9test" | jq .
```

**Pass:** Response contains `"total": 1` and the message appears in `messages[]`.

**Check FTS5 directly:**
```bash
wrangler d1 execute tg-archive --command \
  "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'xqz9test'"
```

---

## Test 3 — Date range filter

Confirms `from`/`to` epoch filtering works and `sent_at` values are integers.

```bash
FROM=$(date -v-1H +%s 2>/dev/null || date -d '1 hour ago' +%s)  # macOS / Linux
TO=$(date +%s)

curl -s -H "X-Ingest-Token: $INGEST_TOKEN" \
  "$WORKER_URL/search?from=$FROM&to=$TO" | jq '{total: .total, sample_sent_at: .messages[0].sent_at}'
```

**Pass:**
- `total` > 0 (assuming messages in the last hour)
- `sample_sent_at` is a large integer (e.g. `1741526400`), **not** a string like `"2026-03-09T..."`

---

## Test 4 — Gap recovery

Confirms missed messages are recovered after a restart.

1. Stop the listener: `fly scale count 0 -a tg-reader`
2. Send yourself **3 messages** in Telegram (to Saved Messages or any chat)
3. Restart: `fly scale count 1 -a tg-reader`
4. Watch startup logs: `fly logs -a tg-reader`
   - You should see `[listener] gap recovery` lines
5. After ~30 seconds, query D1:

```bash
wrangler d1 execute tg-archive --command \
  "SELECT tg_message_id, direction, sent_at FROM messages ORDER BY indexed_at DESC LIMIT 5"
```

**Pass:** All 3 messages appear with the correct `sent_at` timestamps from when they were sent (not from when the listener restarted).

**Note:** Gap recovery only works if `/data/state.json` exists on the volume (i.e. the listener ran at least once before you stopped it). If the volume is fresh, stop and restart once normally first.

---

## Test 5 — Backfill single chat

Confirms backfill works end-to-end on a small chat before running full history.

1. Identify a small chat ID (< 200 messages). Find it in D1 from live capture:

```bash
wrangler d1 execute tg-archive --command \
  "SELECT tg_chat_id, chat_name, COUNT(*) as msg_count FROM messages GROUP BY tg_chat_id ORDER BY msg_count ASC LIMIT 5"
```

2. Seed that one chat manually:

```bash
curl -s -X POST -H "X-Ingest-Token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"dialogs\":[{\"tg_chat_id\":\"<CHAT_ID>\",\"chat_name\":\"Test\",\"total_messages\":null}]}" \
  "$WORKER_URL/backfill/seed" | jq .
```

3. Run the backfill script:

```bash
cd gramjs
GRAMJS_SESSION=<session> API_ID=<id> API_HASH=<hash> \
  INGEST_TOKEN=<token> WORKER_URL=<url> \
  npx ts-node src/backfill-run.ts
```

4. Check completion:

```bash
wrangler d1 execute tg-archive --command \
  "SELECT tg_chat_id, status, fetched_messages, total_messages FROM backfill_state"
```

**Pass:** `status=complete`, `fetched_messages` matches the expected message count for that chat.

---

## All tests passed?

You're ready for full backfill:

```bash
# 1. Seed all dialogs
cd gramjs
GRAMJS_SESSION=... API_ID=... API_HASH=... INGEST_TOKEN=... WORKER_URL=... \
  npx ts-node src/backfill-seed.ts

# 2. Run backfill (can take hours for large accounts — runs overnight)
GRAMJS_SESSION=... API_ID=... API_HASH=... INGEST_TOKEN=... WORKER_URL=... \
  npx ts-node src/backfill-run.ts
```

Monitor progress:
```bash
wrangler d1 execute tg-archive --command \
  "SELECT status, COUNT(*) FROM backfill_state GROUP BY status"
```
