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
// Helpers
// ---------------------------------------------------------------------------

// floodSleepThreshold:300 makes the SDK auto-sleep for FLOOD_WAIT ≤ 300s.
// Any FloodWait error that escapes to our catch blocks is necessarily >300s.
function isFloodWait(errMsg: string): boolean {
  return errMsg.toUpperCase().includes('FLOOD_WAIT');
}

// ---------------------------------------------------------------------------
// Worker API helpers
// ---------------------------------------------------------------------------

async function postProgress(accountId: string, body: {
  tg_chat_id: string;
  status?: string;
  oldest_message_id?: number;
  fetched_messages?: number;
  total_messages?: number;
  last_error?: string;
}): Promise<void> {
  try {
    const res = await fetch(`${WORKER_URL}/backfill/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': accountId },
      body: JSON.stringify(body),
    });
    // Bug 3 fix: check res.ok — a 5xx means checkpoint was NOT saved; log clearly but don't throw
    if (!res.ok) {
      const errBody = await res.text().catch(() => '(unreadable)');
      console.warn(`[backfill] postProgress HTTP ${res.status} body=${errBody} — checkpoint may not have been saved for chat=${body.tg_chat_id}`);
    }
  } catch (err) {
    console.error('[backfill] progress update failed:', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Peer helpers
// ---------------------------------------------------------------------------

// B-1: resolve InputPeer from the GetDialogs result so we carry the real accessHash
// for channels/users instead of bigInt(0), which causes CHANNEL_INVALID errors.
function resolveInputPeerFromResult(
  peer: Api.TypePeer,
  result: Api.messages.Dialogs | Api.messages.DialogsSlice,
): Api.TypeInputPeer {
  if (peer instanceof Api.PeerUser) {
    const user = result.users.find(
      (u): u is Api.User => u instanceof Api.User && u.id.equals(peer.userId),
    );
    return new Api.InputPeerUser({
      userId: peer.userId,
      accessHash: user?.accessHash ?? bigInt(0),
    });
  }
  if (peer instanceof Api.PeerChat) {
    return new Api.InputPeerChat({ chatId: peer.chatId });
  }
  if (peer instanceof Api.PeerChannel) {
    const channel = result.chats.find(
      (c): c is Api.Channel => c instanceof Api.Channel && c.id.equals(peer.channelId),
    );
    return new Api.InputPeerChannel({
      channelId: peer.channelId,
      accessHash: channel?.accessHash ?? bigInt(0),
    });
  }
  return new Api.InputPeerEmpty();
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
  accountId: string,
): Promise<void> {
  const { tg_chat_id } = dialog;
  console.log(`[backfill] dialog ${index + 1}/${total} fetched=${dialog.fetched_messages} total=${dialog.total_messages ?? 'unknown'}`);

  await postProgress(accountId, { tg_chat_id, status: 'in_progress' });

  let offsetId = Number(dialog.oldest_message_id ?? 0);
  let fetched = Number(dialog.fetched_messages ?? 0);
  let totalReported = false; // only send total_messages once (from first page)
  const userMap = new Map<string, { username?: string; firstName?: string; lastName?: string }>();

  let inputPeer: Api.TypeInputPeer;
  try {
    inputPeer = await getInputPeer(client, tg_chat_id);
  } catch (err) {
    console.error(`[backfill] cannot resolve peer for dialog ${index + 1}:`, err instanceof Error ? err.message : String(err));
    await postProgress(accountId, { tg_chat_id, status: 'failed', last_error: String(err) });
    return;
  }

  while (true) {
    let messages: Api.Message[];
    let rawCount: number;
    let lastRawId: number;

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
        await postProgress(accountId, { tg_chat_id, status: 'complete', fetched_messages: fetched });
        console.log(`[backfill] dialog ${index + 1}/${total} complete (unexpected result type) fetched=${fetched}`);
        break;
      }

      // rawCount drives pagination — must use this, not filtered count.
      // MessageService and MessageEmpty (deleted placeholders) are included in
      // result.messages but stripped by the filter below. If we checked
      // filtered count < 100, one deleted/service message in a full page would
      // incorrectly signal end-of-history.
      rawCount = result.messages.length;
      // Bug 2 fix: skip MessageEmpty entries (id=0) when computing the cursor.
      // A MessageEmpty at the tail would set offsetId=0, restarting history from
      // the beginning and causing an infinite loop.
      const lastValidMsg = [...result.messages].reverse().find(m => m.id > 0);
      lastRawId = lastValidMsg ? lastValidMsg.id : 0;
      messages = result.messages.filter(
        (m): m is Api.Message => m instanceof Api.Message,
      );

      // Capture total message count from first page (MessagesSlice / ChannelMessages expose .count).
      // Write it once so backfill_state.total_messages is populated for completeness tracking.
      if (!totalReported && 'count' in result && typeof result.count === 'number') {
        await postProgress(accountId, { tg_chat_id, total_messages: result.count });
        totalReported = true;
      }

      // Build sender lookup from user entities included in the GetHistory response.
      // Telegram includes all referenced users in result.users — no extra API calls needed.
      userMap.clear();
      if ('users' in result && Array.isArray(result.users)) {
        for (const u of result.users) {
          if (u instanceof Api.User) {
            userMap.set(String(u.id), {
              username: u.username ?? undefined,
              firstName: u.firstName ?? undefined,
              lastName: u.lastName ?? undefined,
            });
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // SDK auto-sleeps for FLOOD_WAIT ≤ 300s. If it reaches here the wait is >300s —
      // stop entirely per CLAUDE.md anti-ban rules; resume tomorrow.
      if (isFloodWait(errMsg)) {
        console.error('[backfill] FLOOD_WAIT >300s — stopping. Resume tomorrow.');
        process.exit(1);
      }
      console.error(`[backfill] getHistory error for dialog ${index + 1}:`, errMsg);
      await postProgress(accountId, { tg_chat_id, status: 'failed', last_error: errMsg });
      return;
    }

    if (rawCount === 0) {
      await postProgress(accountId, { tg_chat_id, status: 'complete', fetched_messages: fetched });
      console.log(`[backfill] dialog ${index + 1}/${total} complete (empty page) fetched=${fetched}`);
      break;
    }

    // Bug 2 fix cont'd: if every message in the page was a MessageEmpty (all id=0),
    // lastRawId will be 0 — treat as end-of-history to avoid an infinite loop.
    if (lastRawId === 0) {
      await postProgress(accountId, { tg_chat_id, status: 'complete', fetched_messages: fetched });
      console.log(`[backfill] dialog ${index + 1}/${total} complete (all MessageEmpty page) fetched=${fetched}`);
      break;
    }

    // Map raw Api.Message objects to our Message type.
    // chat_type is not resolved here — the worker stores it from backfill-seed.ts
    // and the ingest endpoint allows it to be undefined (ON CONFLICT preserves existing).
    const batch: Message[] = messages.map(raw => {
      const senderId = resolveSenderId(raw.fromId);
      return {
        tg_message_id: String(raw.id), // S-1: always string
        tg_chat_id,
        chat_name: dialog.chat_name ?? undefined,
        chat_type: undefined,
        sender_id: senderId,
        sender_username: senderId ? (userMap.get(senderId)?.username) : undefined,
        sender_first_name: senderId ? (userMap.get(senderId)?.firstName) : undefined,
        sender_last_name: senderId ? (userMap.get(senderId)?.lastName) : undefined,
        message_type: resolveMessageType(raw),
        text: raw.message || undefined,  // raw.message is the text field in GramJS
        media_type: resolveMediaType(raw.media ?? undefined),
        media_file_id: undefined,
        reply_to_message_id: raw.replyTo?.replyToMsgId != null ? String(raw.replyTo.replyToMsgId) : undefined,
        forwarded_from_id: raw.fwdFrom?.fromId
          ? resolveSenderId(raw.fwdFrom.fromId)
          : undefined,
        forwarded_from_name: raw.fwdFrom?.fromName ?? undefined,
        sent_at: raw.date, // already Unix epoch seconds — DO NOT call new Date()
        edit_date: raw.editDate ?? undefined,
        is_deleted: 0,
        deleted_at: undefined,
      };
    });

    // Skip ingest if all messages in the page were MessageService (calls, joins, etc.)
    if (batch.length === 0) {
      offsetId = lastRawId;
      if (rawCount < 100) {
        await postProgress(accountId, { tg_chat_id, oldest_message_id: offsetId, fetched_messages: fetched, status: 'complete' });
        console.log(`[backfill] dialog ${index + 1}/${total} complete (service-only page) fetched=${fetched}`);
        break;
      }
      await sleep(Math.random() * 2500 + 1500);
      continue;
    }

    // POST batch to /ingest — duplicates are safely handled by ON CONFLICT
    // Bug 1 fix: on non-2xx OR network error, mark dialog failed and return without
    // advancing the cursor. The operator can re-run to retry from the last checkpoint.
    let ingestOk = false;
    try {
      const res = await fetch(`${WORKER_URL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': accountId },
        body: JSON.stringify({ messages: batch }),
      });
      if (!res.ok) {
        console.error(`[backfill] ingest HTTP ${res.status} for dialog ${index + 1} page offsetId=${offsetId} — stopping to prevent data loss`);
        await postProgress(accountId, { tg_chat_id, status: 'failed', last_error: `ingest HTTP ${res.status}` });
        return;
      }
      ingestOk = true;
      const { written, noop } = (await res.json()) as { written: number; noop: number };
      console.log(`[backfill] dialog ${index + 1}/${total} page written=${written} noop=${noop} offsetId=${offsetId}`);
    } catch (err) {
      // Network error — do NOT advance cursor; stop and let operator retry
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[backfill] ingest fetch error:', errMsg, '— stopping to prevent data loss');
      await postProgress(accountId, { tg_chat_id, status: 'failed', last_error: `ingest network error: ${errMsg}` });
      return;
    }

    // Only advance the cursor if ingest succeeded
    if (!ingestOk) return;

    fetched += rawCount; // B-2: track raw count (incl. service msgs) to match what Telegram reports
    // Advance using the raw last item ID — pages past MessageService/MessageEmpty entries
    offsetId = lastRawId;

    // A raw page smaller than the limit means we've reached the beginning of history
    if (rawCount < 100) {
      await postProgress(accountId, { tg_chat_id, oldest_message_id: offsetId, fetched_messages: fetched, status: 'complete' });
      console.log(`[backfill] dialog ${index + 1}/${total} complete fetched=${fetched}`);
      break;
    }

    // Persist resumable progress after each full page
    await postProgress(accountId, { tg_chat_id, oldest_message_id: offsetId, fetched_messages: fetched });

    // Anti-ban sleep: 1.5–4s randomized between pages (CLAUDE.md requirement)
    const sleepMs = Math.random() * 2500 + 1500;
    await sleep(sleepMs);
  }
}

// ---------------------------------------------------------------------------
// Entity cache warmup
// ---------------------------------------------------------------------------

// GramJS needs to have seen a channel/group entity before getInputEntity()
// will resolve it. We warm the cache by paginating GetDialogs at startup.
// Bug 4 fix: replaced iterDialogs (no sleep between internal pages) with a
// manual GetDialogs loop that applies anti-ban sleep between every page.
async function warmEntityCache(client: TelegramClient): Promise<void> {
  console.log('[backfill] warming entity cache...');
  let count = 0;
  let offsetDate = 0;
  let offsetId = 0;
  let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
  const limit = 100;
  let page = 0;

  while (true) {
    page++;
    const result = await client.invoke(
      new Api.messages.GetDialogs({
        offsetDate,
        offsetId,
        offsetPeer,
        limit,
        hash: bigInt(0),
      }),
    );

    if (
      !(result instanceof Api.messages.Dialogs || result instanceof Api.messages.DialogsSlice)
    ) {
      break;
    }

    const dlgs = result.dialogs;
    count += dlgs.length;

    // Full Dialogs (non-slice) or short page — we're done
    if (result instanceof Api.messages.Dialogs || dlgs.length < limit) {
      break;
    }

    // Advance offset using the last dialog's top message date/id/peer
    const lastDlg = dlgs[dlgs.length - 1];
    if (lastDlg instanceof Api.Dialog) {
      const lastMsg = result.messages.find((m: Api.TypeMessage) => m.id === lastDlg.topMessage);
      if (lastMsg && 'date' in lastMsg) {
        offsetDate = (lastMsg as { date: number }).date;
        offsetId = lastMsg.id;
        // B-1: use real accessHash from result to avoid CHANNEL_INVALID on next page
        offsetPeer = resolveInputPeerFromResult(lastDlg.peer, result);
      } else {
        console.warn(`[backfill] warmEntityCache page=${page} topMessage not found, stopping early`);
        break;
      }
    }

    // Anti-ban: randomized sleep between pages (CLAUDE.md requirement: 1.5–4s)
    await sleep(Math.random() * 2500 + 1500);
  }

  console.log(`[backfill] entity cache warmed pages=${page} count=${count}`);
}

// ---------------------------------------------------------------------------
// Exported orchestration (used by backfill.ts)
// ---------------------------------------------------------------------------

export { runBackfill };

// ---------------------------------------------------------------------------
// Main backfill orchestration
// ---------------------------------------------------------------------------

async function runBackfill(client: TelegramClient, accountId?: string): Promise<void> {
  const effectiveAccountId = accountId ?? ACCOUNT_ID;

  // Warm entity cache so getInputEntity resolves channels/supergroups correctly
  await warmEntityCache(client);

  const pendingRes = await fetch(`${WORKER_URL}/backfill/pending`, {
    headers: { 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': effectiveAccountId },
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
    await backfillDialog(client, pending[i], i, pending.length, effectiveAccountId);
    // Anti-ban: sleep between dialogs (1.5–4s randomized)
    if (i < pending.length - 1) {
      await sleep(Math.random() * 2500 + 1500);
    }
  }

  console.log(`[backfill] all ${pending.length} dialogs processed`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // B-6: per CLAUDE.md, backfill must not run immediately after first login.
  // The operator must explicitly set BACKFILL_ALLOWED=true after running the listener
  // for 1-2 days to warm up the session and avoid FLOOD_WAIT bans.
  if (process.env['BACKFILL_ALLOWED'] !== 'true') {
    console.error(
      '[backfill] BACKFILL_ALLOWED env var is not set to "true".\n' +
      '  Per CLAUDE.md anti-ban rules: run the listener for 1-2 days before backfilling.\n' +
      '  Once ready, set BACKFILL_ALLOWED=true (Fly secret or .env) and re-run.',
    );
    process.exit(1);
  }

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

  // Derive account ID from the authenticated user if not set via env.
  // Bug 6 fix: ACCOUNT_ID must be set BEFORE calling runBackfill so the module-level
  // variable is populated when runBackfill falls back to it. Pass it explicitly too.
  if (!ACCOUNT_ID) {
    const me = await client.getMe();
    if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty — session is invalid');
    ACCOUNT_ID = String(me.id);
  }
  console.log(`[backfill] account_id=${ACCOUNT_ID}`);

  try {
    await runBackfill(client, ACCOUNT_ID);
  } finally {
    await client.disconnect();
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[backfill] fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
