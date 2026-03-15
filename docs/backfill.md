# Backfill

Backfill imports your complete message history into the archive. It's a one-time operation per account.

## When to run

- The listener must be **scaled down** before running backfill — both cannot use the same session simultaneously
- Can be run immediately after first login — the built-in sleep randomization and serial fetch pattern are sufficient

## Anti-ban measures (built-in)

- 1.5–4s randomized sleep between each page of 100 messages
- Serial processing — one chat at a time, never parallel
- Auto-sleep on FLOOD_WAIT up to 5 minutes (`floodSleepThreshold: 300`)
- Automatic exit if FLOOD_WAIT exceeds 300s — the script stops immediately and prints "Resume tomorrow."
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
- If FLOOD_WAIT exceeds 5 minutes the script exits automatically — re-run the next day to resume

---

## One-time migration scripts

These scripts fix data gaps from earlier backfills and are safe to re-run (idempotent):

### Enrich chat types

Populates missing `chat_type` values using `GetDialogs`:

```bash
cd gramjs
npx ts-node src/enrich-chat-type.ts
```

Requires `GRAMJS_SESSION`, `API_ID`, `API_HASH`, `DATABASE_URL`.

### Enrich sender info

Fills `sender_username` / `sender_first_name` / `sender_last_name` using `GetParticipants` for group chats:

```bash
npx ts-node src/enrich-senders.ts
```

Requires the same env vars as above. Only updates rows where sender info is still NULL.
