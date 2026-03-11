import bigInt from 'big-integer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import type { Message } from './types';
import { requireEnv, sleep, resolveSenderId, resolveMediaType, resolveMessageType } from './utils';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const GRAMJS_SESSION = requireEnv('GRAMJS_SESSION');
const API_ID_STR = requireEnv('API_ID');
const API_HASH = requireEnv('API_HASH');
const INGEST_TOKEN = requireEnv('INGEST_TOKEN');
const WORKER_URL = requireEnv('WORKER_URL');
let ACCOUNT_ID = process.env['ACCOUNT_ID'] ?? '';

const API_ID = parseInt(API_ID_STR, 10);
if (isNaN(API_ID)) {
  throw new Error(`API_ID must be a valid integer, got: ${API_ID_STR}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingDialog {
  tg_chat_id: string;
  chat_name: string | null;
  total_messages: number | null;
  fetched_messages: number;
  oldest_message_id: number | null;
  status: string;
}


// ---------------------------------------------------------------------------
// Worker API helpers
// ---------------------------------------------------------------------------

async function postProgress(body: {
  tg_chat_id: string;
  status?: string;
  oldest_message_id?: number;
  fetched_messages?: number;
  last_error?: string;
}): Promise<void> {
  try {
    await fetch(`${WORKER_URL}/backfill/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[backfill] progress update failed:', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// InputPeer resolution
// ---------------------------------------------------------------------------

async function getInputPeer(client: TelegramClient, tgChatId: string): Promise<Api.TypeInputPeer> {
  try {
    const entity = await client.getInputEntity(tgChatId);
    return entity as Api.TypeInputPeer;
  } catch (err) {
    throw new Error(
      `Cannot resolve entity for chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-dialog backfill loop
// ---------------------------------------------------------------------------

async function backfillDialog(
  client: TelegramClient,
  dialog: PendingDialog,
  index: number,
  total: number,
): Promise<void> {
  const { tg_chat_id } = dialog;
  console.log(`[backfill] dialog ${index + 1}/${total} fetched=${dialog.fetched_messages} total=${dialog.total_messages ?? 'unknown'}`);

  await postProgress({ tg_chat_id, status: 'in_progress' });

  let offsetId = dialog.oldest_message_id ?? 0;
  let fetched = dialog.fetched_messages ?? 0;

  let inputPeer: Api.TypeInputPeer;
  try {
    inputPeer = await getInputPeer(client, tg_chat_id);
  } catch (err) {
    console.error(`[backfill] cannot resolve peer for dialog ${index + 1}:`, err instanceof Error ? err.message : String(err));
    await postProgress({ tg_chat_id, status: 'failed', last_error: String(err) });
    return;
  }

  while (true) {
    let messages: Api.Message[];

    try {
      const result = await client.invoke(
        new Api.messages.GetHistory({
          peer: inputPeer,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: 100,
          maxId: 0,
          minId: 0,
          hash: bigInt(0),
        }),
      );

      if (
        !(
          result instanceof Api.messages.Messages ||
          result instanceof Api.messages.MessagesSlice ||
          result instanceof Api.messages.ChannelMessages
        )
      ) {
        // NotModified or other unexpected variant — treat as complete
        await postProgress({ tg_chat_id, status: 'complete', fetched_messages: fetched });
        console.log(`[backfill] dialog ${index + 1}/${total} complete (unexpected result type) fetched=${fetched}`);
        break;
      }

      messages = result.messages.filter(
        (m): m is Api.Message => m instanceof Api.Message,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] getHistory error for dialog ${index + 1}:`, errMsg);
      await postProgress({ tg_chat_id, status: 'failed', last_error: errMsg });
      return;
    }

    if (messages.length === 0) {
      await postProgress({ tg_chat_id, status: 'complete', fetched_messages: fetched });
      console.log(`[backfill] dialog ${index + 1}/${total} complete (empty page) fetched=${fetched}`);
      break;
    }

    // Map raw Api.Message objects to our Message type.
    // chat_type is not resolved here — the worker stores it from backfill-seed.ts
    // and the ingest endpoint allows it to be undefined (ON CONFLICT preserves existing).
    const batch: Message[] = messages.map(raw => ({
      tg_message_id: raw.id,
      tg_chat_id,
      chat_name: dialog.chat_name ?? undefined,
      chat_type: undefined,
      sender_id: resolveSenderId(raw.fromId),
      sender_username: undefined,
      sender_first_name: undefined,
      sender_last_name: undefined,
      direction: (raw.out ?? false) ? 'out' : 'in',
      message_type: resolveMessageType(raw),
      text: raw.message || undefined,  // raw.message is the text field in GramJS
      media_type: resolveMediaType(raw.media ?? undefined),
      media_file_id: undefined,
      reply_to_message_id: raw.replyTo?.replyToMsgId ?? undefined,
      forwarded_from_id: raw.fwdFrom?.fromId
        ? resolveSenderId(raw.fwdFrom.fromId)
        : undefined,
      forwarded_from_name: raw.fwdFrom?.fromName ?? undefined,
      sent_at: raw.date, // already Unix epoch seconds — DO NOT call new Date()
      edit_date: raw.editDate ?? undefined,
      is_deleted: 0,
      deleted_at: undefined,
    }));

    // POST batch to /ingest — duplicates are safely handled by ON CONFLICT in D1
    try {
      const res = await fetch(`${WORKER_URL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
        body: JSON.stringify({ messages: batch }),
      });
      if (!res.ok) {
        console.error(`[backfill] ingest HTTP ${res.status} for dialog ${index + 1} page offsetId=${offsetId}`);
      } else {
        const { inserted, skipped } = (await res.json()) as { inserted: number; skipped: number };
        console.log(`[backfill] dialog ${index + 1}/${total} page inserted=${inserted} skipped=${skipped} offsetId=${offsetId}`);
      }
    } catch (err) {
      // Network error — log and continue. ON CONFLICT handles any duplicates on retry.
      console.error('[backfill] ingest fetch error:', err instanceof Error ? err.message : String(err));
    }

    fetched += messages.length;
    // Next page starts from the smallest (oldest) message id in this batch
    offsetId = messages[messages.length - 1].id;

    // A page smaller than the limit means we've reached the beginning of history
    if (messages.length < 100) {
      // Combine progress + completion into a single call
      await postProgress({ tg_chat_id, oldest_message_id: offsetId, fetched_messages: fetched, status: 'complete' });
      console.log(`[backfill] dialog ${index + 1}/${total} complete fetched=${fetched}`);
      break;
    }

    // Persist resumable progress after each full page
    await postProgress({ tg_chat_id, oldest_message_id: offsetId, fetched_messages: fetched });

    // Anti-ban sleep: 1.5–4s randomized between pages (CLAUDE.md requirement)
    const sleepMs = Math.random() * 2500 + 1500;
    await sleep(sleepMs);
  }
}

// ---------------------------------------------------------------------------
// Entity cache warmup
// ---------------------------------------------------------------------------

// GramJS needs to have seen a channel/group entity before getInputEntity()
// will resolve it. We warm the cache by iterating all dialogs once at startup.
// This is a read-only API call with no anti-ban risk.
async function warmEntityCache(client: TelegramClient): Promise<void> {
  console.log('[backfill] warming entity cache...');
  let count = 0;
  for await (const _ of client.iterDialogs({})) {
    count++;
  }
  console.log(`[backfill] entity cache warmed count=${count}`);
}

// ---------------------------------------------------------------------------
// Exported orchestration (used by backfill.ts)
// ---------------------------------------------------------------------------

export { runBackfill };

// ---------------------------------------------------------------------------
// Main backfill orchestration
// ---------------------------------------------------------------------------

async function runBackfill(client: TelegramClient): Promise<void> {
  // Warm entity cache so getInputEntity resolves channels/supergroups correctly
  await warmEntityCache(client);

  const pendingRes = await fetch(`${WORKER_URL}/backfill/pending`, {
    headers: { 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
  });

  if (!pendingRes.ok) {
    throw new Error(`GET /backfill/pending failed: HTTP ${pendingRes.status}`);
  }

  const pending = (await pendingRes.json()) as PendingDialog[];
  console.log(`[backfill] ${pending.length} dialogs pending`);

  if (pending.length === 0) {
    console.log('[backfill] nothing to do — all dialogs complete or none seeded');
    return;
  }

  // Process dialogs serially — never parallel (anti-ban rule from CLAUDE.md)
  for (let i = 0; i < pending.length; i++) {
    await backfillDialog(client, pending[i], i, pending.length);
  }

  console.log(`[backfill] all ${pending.length} dialogs processed`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const session = new StringSession(GRAMJS_SESSION);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    floodSleepThreshold: 300,
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('AUTH_KEY_DUPLICATED')) {
      console.error('[backfill] AUTH_KEY_DUPLICATED — another session is active. Scale down Fly first:\n  fly scale count 0 --yes -a tg-reader\n  fly scale count 0 --yes -a tg-reader-main');
      process.exit(1);
    }
    throw err;
  }
  console.log('[backfill] connected to Telegram');

  // Derive account ID from the authenticated user if not set via env
  if (!ACCOUNT_ID) {
    const me = await client.getMe();
    if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty — session is invalid');
    ACCOUNT_ID = String(me.id);
  }
  console.log(`[backfill] account_id=${ACCOUNT_ID}`);

  try {
    await runBackfill(client);
  } finally {
    await client.disconnect();
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[backfill] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
