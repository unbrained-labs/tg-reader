/**
 * backfill.ts — unified entry point for backfilling a Telegram account.
 *
 * Runs seed (enumerate dialogs) then run (fetch history) in sequence.
 * Safe to re-run — already-completed dialogs are skipped automatically.
 *
 * Prerequisites:
 *   1. Scale down the Fly listener for this account before running:
 *      fly scale count 0 --yes -a <app>
 *   2. Set env vars: GRAMJS_SESSION, API_ID, API_HASH, INGEST_TOKEN, WORKER_URL
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { requireEnv } from './utils';
import { runSeed } from './backfill-seed';
import { runBackfill } from './backfill-run';

const GRAMJS_SESSION = requireEnv('GRAMJS_SESSION');
const API_ID = parseInt(requireEnv('API_ID'), 10);
const API_HASH = requireEnv('API_HASH');
let ACCOUNT_ID = process.env['ACCOUNT_ID'] ?? '';

if (isNaN(API_ID)) throw new Error(`API_ID must be a valid integer`);

async function main(): Promise<void> {
  const session = new StringSession(GRAMJS_SESSION);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    floodSleepThreshold: 300,
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  // Connect
  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('AUTH_KEY_DUPLICATED')) {
      console.error('[backfill] AUTH_KEY_DUPLICATED — scale down the Fly listener first:\n  fly scale count 0 --yes -a <app>');
      process.exit(1);
    }
    throw err;
  }
  console.log('[backfill] connected to Telegram');

  // Derive account ID
  if (!ACCOUNT_ID) {
    const me = await client.getMe();
    if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty — session is invalid');
    ACCOUNT_ID = String(me.id);
  }
  console.log(`[backfill] account_id=${ACCOUNT_ID}`);

  // Step 1 — Seed: enumerate dialogs and register in D1
  // runSeed disconnects the client after enumerating (before hitting the Worker)
  console.log('[backfill] step 1/2 — seeding dialogs...');
  await runSeed(client, ACCOUNT_ID);

  // Step 2 — Run: fetch message history for all pending dialogs
  // Reconnect since seed disconnected
  console.log('[backfill] step 2/2 — fetching history...');
  await client.connect();
  try {
    await runBackfill(client);
  } finally {
    await client.disconnect();
  }

  console.log('[backfill] all done.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[backfill] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
