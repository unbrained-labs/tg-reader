# Gap-Fill Recovery

Use this tool when the listener went into a zombie ping-loop state and the archive has a gap — i.e. a period during which messages were not ingested despite the listener appearing to run. The script fetches recent Telegram history for every dialog (newest → oldest) and ingests only messages with `sent_at > GAP_START_TS`, stopping per-chat as soon as it hits messages that are already in the archive.

## When to use

- Listener ran as a zombie (connected but not processing updates) for an extended period
- `stats` MCP tool shows `latest_message_at` far in the past despite the listener appearing healthy
- You need to replay a bounded time window without re-running the full backfill

## Prerequisites

1. **Stop the listener first.** Running gap-fill while the listener is active risks double-ingest and AUTH_KEY_DUPLICATED errors.
   ```bash
   flyctl machine stop -a <your-fly-app>
   # or: fly scale count 0 --yes -a <your-fly-app>
   ```

2. **Set `GAP_START_TS`** to the Unix-epoch-seconds timestamp of the last message that _was_ correctly ingested before the gap. Get it from the `stats` MCP tool's `latest_message_at` field, or query the DB directly.

3. **Set `BACKFILL_ALLOWED=true`** — the script refuses to run without this guard.

4. Ensure your `.env` has the usual gramjs vars: `GRAMJS_SESSION`, `API_ID`, `API_HASH`, `INGEST_TOKEN`, `WORKER_URL`.

## Running

```bash
cd gramjs
set -a && . ./.env && set +a
BACKFILL_ALLOWED=true GAP_START_TS=<unix_epoch_seconds> npm run gap-fill
```

Replace `<unix_epoch_seconds>` with the integer timestamp from step 2 above.

## Expected behaviour

- Enumerates all dialogs first (~1–2 min for ~1800 dialogs), then processes each serially.
- For silent chats (no messages since `GAP_START_TS`) nothing is logged — this is normal.
- Only chats with actual gap messages produce output lines.
- Total runtime: ~90 minutes for ~1800 dialogs.
- All inserts use `ON CONFLICT DO UPDATE` — safe to re-run if interrupted.

## After it completes

Restart the listener:
```bash
flyctl machine start -a <your-fly-app>
# or: fly scale count 1 --yes -a <your-fly-app>
```

Verify recovery with the `stats` MCP tool — `latest_message_at` should now be close to the current time.

## Notes

- Do **not** run gap-fill while the listener is active — stop it first.
- The script exits automatically if a FLOOD_WAIT error exceeds 300 s; re-run the next day to resume.
- `GAP_START_TS` defaults to a hardcoded value in the source if not set — always supply it explicitly.
