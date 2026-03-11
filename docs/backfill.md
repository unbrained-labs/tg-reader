# Backfill

Backfill imports your complete message history into the archive. It's a one-time operation per account.

## When to run

- **Wait 1-2 days** after first deploying the listener before running backfill
- Running too soon (new session + immediate mass fetching) looks suspicious to Telegram
- The listener must be **scaled down** before running backfill — both cannot use the same session simultaneously

## Anti-ban measures (built-in)

- 1.5–4s randomized sleep between each page of 100 messages
- Serial processing — one chat at a time, never parallel
- Auto-sleep on FLOOD_WAIT up to 5 minutes
- Fully resumable — if interrupted, picks up exactly where it left off

## Running backfill

### Step 1 — Scale down the listener

```bash
fly scale count 0 --yes -a <your-fly-app>
```

### Step 2 — Run backfill

```bash
# From the gramjs directory, with .env loaded:
set -a && source .env && set +a
npx ts-node src/backfill.ts
```

Or on Fly (if session is stored there):

```bash
fly machine run . --app <your-fly-app> --entrypoint "node" -- dist/backfill.js
```

`backfill.ts` runs both steps automatically in sequence:
1. **Seed** — enumerates all dialogs and registers them in D1
2. **Run** — fetches message history for each dialog

### Step 3 — Restart the listener

```bash
fly scale count 1 --yes -a <your-fly-app>
```

## Resuming after interruption

If backfill is interrupted (crash, flood wait, manual stop), just re-run `backfill.ts` — it reads the `backfill_state` table and skips already-completed dialogs. No data is duplicated. Seeding is also safe to re-run — existing dialogs are not overwritten.

## Checking progress

```bash
# Count by status
wrangler d1 execute tg-archive --remote \
  --command "SELECT status, COUNT(*) FROM backfill_state WHERE account_id='<id>' GROUP BY status"

# Total messages ingested
wrangler d1 execute tg-archive --remote \
  --command "SELECT COUNT(*) FROM messages WHERE account_id='<id>'"
```

## Notes

- Backfill only needs to run once — the live listener captures everything going forward
- Scale the listener back up immediately after backfill completes
