# Backfill

Backfill imports your complete message history into the archive. It's a one-time operation per account.

## When to run

- **Wait 1–2 days** after first deploying the listener before running backfill
- Running too soon (new session + immediate mass fetching) looks suspicious to Telegram
- The listener must be **scaled down** before running backfill — both cannot use the same session simultaneously

## Anti-ban measures (built-in)

- 1.5–4s randomized sleep between each page of 100 messages
- Serial processing — one chat at a time, never parallel
- Auto-sleep on FLOOD_WAIT up to 5 minutes (`floodSleepThreshold: 300`)
- Fully resumable — if interrupted, picks up exactly where it left off

## Running backfill

### Step 1 — Scale down the listener

```bash
fly scale count 0 --yes -a <your-fly-app>
```

### Step 2 — Seed backfill state

Enumerate all dialogs and register them in the `backfill_state` table:

```bash
cd gramjs
set -a && source .env && set +a
npx ts-node src/backfill-seed.ts
```

Safe to re-run — existing entries are not overwritten.

### Step 3 — Run backfill

Fetch message history for each dialog and POST to `/ingest`:

```bash
npx ts-node src/backfill-run.ts
```

Runs until all dialogs are `complete`. Resumable — re-run after any interruption.

### Step 4 — Restart the listener

```bash
fly scale count 1 --yes -a <your-fly-app>
```

## Checking progress

```bash
psql $DATABASE_URL -c \
  "SELECT status, COUNT(*) FROM backfill_state WHERE account_id='<id>' GROUP BY status"

psql $DATABASE_URL -c \
  "SELECT COUNT(*) FROM messages WHERE account_id='<id>'"
```

## Notes

- Backfill only needs to run once — the live listener captures everything going forward
- Scale the listener back up immediately after backfill completes
- If FLOOD_WAIT exceeds 5 minutes, stop and resume the next day
