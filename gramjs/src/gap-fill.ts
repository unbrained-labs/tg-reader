/**
 * gap-fill.ts — fills a recent gap in the archive.
 *
 * For each chat, fetches recent Telegram history (newest → oldest) and ingests
 * only messages with sent_at > GAP_START_TS. Stops per-chat as soon as a page
 * contains a message older than the gap start (those are already in the DB).
 *
 * Safe to run any time — all inserts use ON CONFLICT DO UPDATE.
 *
 * Prerequisites:
 *   fly scale count 0 --yes -a <your-fly-app>   (stop listener first)
 *   BACKFILL_ALLOWED=true in .env
 */

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
const API_ID = parseInt(requireEnv('API_ID'), 10);
const API_HASH = requireEnv('API_HASH');
const INGEST_TOKEN = requireEnv('INGEST_TOKEN');
const WORKER_URL = requireEnv('WORKER_URL');
let ACCOUNT_ID = process.env['ACCOUNT_ID'] ?? '';

if (isNaN(API_ID)) throw new Error('API_ID must be a valid integer');

// Unix epoch seconds of the last message in the archive before the gap.
// Messages with sent_at > GAP_START_TS are in the gap and need to be ingested.
const GAP_START_TS = parseInt(process.env['GAP_START_TS'] ?? '1774871233', 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFloodWait(errMsg: string): boolean {
  return errMsg.toUpperCase().includes('FLOOD_WAIT');
}

async function ingestBatch(batch: Message[], accountId: string): Promise<{ written: number; noop: number }> {
  const res = await fetch(`${WORKER_URL}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': accountId },
    body: JSON.stringify({ messages: batch }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`ingest HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<{ written: number; noop: number }>;
}

// ---------------------------------------------------------------------------
// Resolve inputPeer from GetDialogs result (same as backfill-run)
// ---------------------------------------------------------------------------

function resolveInputPeer(
  peer: Api.TypePeer,
  result: Api.messages.Dialogs | Api.messages.DialogsSlice,
): Api.TypeInputPeer {
  if (peer instanceof Api.PeerUser) {
    const user = result.users.find(
      (u): u is Api.User => u instanceof Api.User && u.id.equals(peer.userId),
    );
    return new Api.InputPeerUser({ userId: peer.userId, accessHash: user?.accessHash ?? bigInt(0) });
  }
  if (peer instanceof Api.PeerChat) {
    return new Api.InputPeerChat({ chatId: peer.chatId });
  }
  if (peer instanceof Api.PeerChannel) {
    const ch = result.chats.find(
      (c): c is Api.Channel => c instanceof Api.Channel && c.id.equals(peer.channelId),
    );
    return new Api.InputPeerChannel({ channelId: peer.channelId, accessHash: ch?.accessHash ?? bigInt(0) });
  }
  return new Api.InputPeerEmpty();
}

// ---------------------------------------------------------------------------
// Per-dialog gap fill
// ---------------------------------------------------------------------------

interface DialogInfo {
  tg_chat_id: string;
  chat_name: string | null;
  inputPeer: Api.TypeInputPeer;
}

async function fillDialogGap(
  client: TelegramClient,
  dialog: DialogInfo,
  index: number,
  total: number,
  accountId: string,
): Promise<void> {
  const { tg_chat_id, chat_name, inputPeer } = dialog;
  let offsetId = 0; // start from newest
  let totalWritten = 0;
  let pages = 0;

  while (true) {
    let result: Api.messages.Messages | Api.messages.MessagesSlice | Api.messages.ChannelMessages;
    try {
      const raw = await client.invoke(
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
        !(raw instanceof Api.messages.Messages ||
          raw instanceof Api.messages.MessagesSlice ||
          raw instanceof Api.messages.ChannelMessages)
      ) {
        break; // NotModified or unexpected type — treat as done
      }
      result = raw;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isFloodWait(errMsg)) {
        console.error('[gap-fill] FLOOD_WAIT >300s — stopping. Resume tomorrow.');
        process.exit(1);
      }
      console.error(`[gap-fill] getHistory error for chat ${tg_chat_id}:`, errMsg);
      return;
    }

    pages++;
    const rawMessages = result.messages;
    if (rawMessages.length === 0) break;

    // Find the oldest valid (non-zero) message ID for cursor advancement
    const lastValidMsg = [...rawMessages].reverse().find(m => m.id > 0);
    const lastRawId = lastValidMsg ? lastValidMsg.id : 0;
    if (lastRawId === 0) break;

    // Build user lookup from result
    const userMap = new Map<string, { username?: string; firstName?: string; lastName?: string }>();
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

    // Split into gap messages (need ingesting) and old messages (already in DB)
    const gapMessages: Message[] = [];
    let hitOld = false;

    for (const raw of rawMessages) {
      if (!(raw instanceof Api.Message)) continue;
      if (raw.date <= GAP_START_TS) {
        hitOld = true;
        continue; // skip — already in DB
      }
      const senderId = resolveSenderId(raw.fromId);
      gapMessages.push({
        tg_message_id: String(raw.id),
        tg_chat_id,
        chat_name: chat_name ?? undefined,
        chat_type: undefined, // backfill doesn't know — ON CONFLICT preserves existing
        sender_id: senderId,
        sender_username: senderId ? userMap.get(senderId)?.username : undefined,
        sender_first_name: senderId ? userMap.get(senderId)?.firstName : undefined,
        sender_last_name: senderId ? userMap.get(senderId)?.lastName : undefined,
        message_type: resolveMessageType(raw),
        text: raw.message || undefined,
        media_type: resolveMediaType(raw.media ?? undefined),
        media_file_id: undefined,
        reply_to_message_id: raw.replyTo?.replyToMsgId != null ? String(raw.replyTo.replyToMsgId) : undefined,
        forwarded_from_id: raw.fwdFrom?.fromId ? resolveSenderId(raw.fwdFrom.fromId) : undefined,
        forwarded_from_name: raw.fwdFrom?.fromName ?? undefined,
        sent_at: raw.date,
        edit_date: raw.editDate ?? undefined,
        is_deleted: 0,
        deleted_at: undefined,
      });
    }

    if (gapMessages.length > 0) {
      try {
        const { written, noop } = await ingestBatch(gapMessages, accountId);
        totalWritten += written;
        console.log(`[gap-fill] ${index + 1}/${total} chat=${tg_chat_id} page=${pages} gap_msgs=${gapMessages.length} written=${written} noop=${noop}`);
      } catch (err) {
        console.error(`[gap-fill] ingest failed for chat ${tg_chat_id}:`, err instanceof Error ? err.message : String(err));
        return;
      }
    }

    // Stop conditions
    if (hitOld) break; // reached messages already in DB
    if (rawMessages.length < 100) break; // end of history

    offsetId = lastRawId;
    await sleep(Math.random() * 2500 + 1500);
  }

  if (totalWritten > 0) {
    console.log(`[gap-fill] ${index + 1}/${total} chat=${tg_chat_id} done pages=${pages} total_written=${totalWritten}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env['BACKFILL_ALLOWED'] !== 'true') {
    console.error('[gap-fill] Set BACKFILL_ALLOWED=true to run.');
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
      console.error('[gap-fill] AUTH_KEY_DUPLICATED — scale down the listener first:\n  fly scale count 0 --yes -a <your-fly-app>');
      process.exit(1);
    }
    throw err;
  }
  console.log('[gap-fill] connected to Telegram');

  if (!ACCOUNT_ID) {
    const me = await client.getMe();
    if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty');
    ACCOUNT_ID = String(me.id);
  }
  console.log(`[gap-fill] account_id=${ACCOUNT_ID} gap_start_ts=${GAP_START_TS}`);

  // Enumerate all dialogs via GetDialogs (needed to resolve inputPeers)
  console.log('[gap-fill] enumerating dialogs...');
  const dialogs: DialogInfo[] = [];
  let offsetDate = 0;
  let offsetId = 0;
  let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
  let page = 0;

  while (true) {
    page++;
    const result = await client.invoke(
      new Api.messages.GetDialogs({
        offsetDate, offsetId, offsetPeer,
        limit: 100,
        hash: bigInt(0),
      }),
    );

    if (!(result instanceof Api.messages.Dialogs || result instanceof Api.messages.DialogsSlice)) break;

    for (const dlg of result.dialogs) {
      if (!(dlg instanceof Api.Dialog)) continue;
      const peer = dlg.peer;
      let tg_chat_id: string;
      let chat_name: string | null = null;

      if (peer instanceof Api.PeerUser) {
        tg_chat_id = String(peer.userId);
        const u = result.users.find((u): u is Api.User => u instanceof Api.User && u.id.equals(peer.userId));
        if (u) chat_name = [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
      } else if (peer instanceof Api.PeerChat) {
        tg_chat_id = String(peer.chatId);
        const c = result.chats.find(c => 'id' in c && (c as { id: typeof peer.chatId }).id.equals(peer.chatId));
        if (c && 'title' in c) chat_name = (c as { title: string }).title;
      } else if (peer instanceof Api.PeerChannel) {
        tg_chat_id = String(peer.channelId);
        const c = result.chats.find(
          (c): c is Api.Channel => c instanceof Api.Channel && c.id.equals(peer.channelId),
        );
        if (c) chat_name = c.title;
      } else {
        continue;
      }

      dialogs.push({ tg_chat_id, chat_name, inputPeer: resolveInputPeer(peer, result) });
    }

    if (result instanceof Api.messages.Dialogs || result.dialogs.length < 100) break;

    const lastDlg = result.dialogs[result.dialogs.length - 1];
    if (lastDlg instanceof Api.Dialog) {
      const lastMsg = result.messages.find((m: Api.TypeMessage) => m.id === lastDlg.topMessage);
      if (lastMsg && 'date' in lastMsg) {
        offsetDate = (lastMsg as { date: number }).date;
        offsetId = lastMsg.id;
        offsetPeer = resolveInputPeer(lastDlg.peer, result);
      } else break;
    } else break;

    await sleep(Math.random() * 2500 + 1500);
  }

  console.log(`[gap-fill] found ${dialogs.length} dialogs across ${page} pages`);

  // Fill gap for each dialog
  for (let i = 0; i < dialogs.length; i++) {
    await fillDialogGap(client, dialogs[i], i, dialogs.length, ACCOUNT_ID);
    if (i < dialogs.length - 1) {
      await sleep(Math.random() * 2500 + 1500);
    }
  }

  console.log('[gap-fill] complete.');
  await client.disconnect();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[gap-fill] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
