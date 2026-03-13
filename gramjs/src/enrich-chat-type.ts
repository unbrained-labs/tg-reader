/**
 * enrich-chat-type.ts — one-time script to populate chat_type on backfilled messages.
 *
 * GetDialogs returns the peer type for every dialog, which is the authoritative
 * source for chat_type. This script enumerates all dialogs, derives chat_type,
 * and UPDATEs messages in bulk via Neon.
 *
 * Run once:  npx ts-node src/enrich-chat-type.ts
 * Safe to re-run — uses WHERE chat_type IS NULL so already-filled rows are skipped.
 *
 * Prerequisites: scale down Fly listener before running.
 */

import bigInt from 'big-integer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { Pool } from 'pg';
import { requireEnv, sleep } from './utils';

const GRAMJS_SESSION = requireEnv('GRAMJS_SESSION');
const API_ID = parseInt(requireEnv('API_ID'), 10);
const API_HASH = requireEnv('API_HASH');
const DATABASE_URL = requireEnv('DATABASE_URL');

if (isNaN(API_ID)) throw new Error('API_ID must be a valid integer');

type ChatTypeEntry = { tg_chat_id: string; chat_type: string };

async function enumerateDialogTypes(client: TelegramClient): Promise<ChatTypeEntry[]> {
  const entries: ChatTypeEntry[] = [];
  let offsetDate = 0;
  let offsetId = 0;
  let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
  const limit = 100;
  let page = 0;

  while (true) {
    page++;
    console.log(`[enrich-chat-type] page=${page}`);

    const result: Api.messages.TypeDialogs = await client.invoke(
      new Api.messages.GetDialogs({
        offsetDate, offsetId, offsetPeer, limit, hash: bigInt(0),
      }),
    );

    if (
      result instanceof Api.messages.DialogsNotModified ||
      !(result instanceof Api.messages.Dialogs || result instanceof Api.messages.DialogsSlice)
    ) {
      break;
    }

    for (const dlg of result.dialogs) {
      if (!(dlg instanceof Api.Dialog)) continue;
      const peer = dlg.peer;

      if (peer instanceof Api.PeerUser) {
        entries.push({ tg_chat_id: String(peer.userId), chat_type: 'user' });
      } else if (peer instanceof Api.PeerChat) {
        entries.push({ tg_chat_id: String(peer.chatId), chat_type: 'group' });
      } else if (peer instanceof Api.PeerChannel) {
        const channelEntity = result.chats.find(
          (c): c is Api.Channel => c instanceof Api.Channel && String(c.id) === String(peer.channelId),
        );
        const chat_type = channelEntity?.megagroup ? 'supergroup' : 'channel';
        entries.push({ tg_chat_id: String(peer.channelId), chat_type });
      }
    }

    if (result instanceof Api.messages.Dialogs || result.dialogs.length < limit) break;

    const lastDlg: Api.TypeDialog = result.dialogs[result.dialogs.length - 1];
    if (lastDlg instanceof Api.Dialog) {
      const lastMsg = result.messages.find((m: Api.TypeMessage) => m.id === lastDlg.topMessage);
      if (lastMsg && 'date' in lastMsg) {
        offsetDate = (lastMsg as Api.Message).date;
        offsetId = lastMsg.id;
        // Resolve InputPeer with real accessHash to avoid CHANNEL_INVALID on next page
        const dlgPeer: Api.TypePeer = lastDlg.peer;
        if (dlgPeer instanceof Api.PeerUser) {
          const user = result.users.find((u: Api.TypeUser): u is Api.User => u instanceof Api.User && u.id.equals(dlgPeer.userId));
          offsetPeer = new Api.InputPeerUser({ userId: dlgPeer.userId, accessHash: user?.accessHash ?? bigInt(0) });
        } else if (dlgPeer instanceof Api.PeerChat) {
          offsetPeer = new Api.InputPeerChat({ chatId: dlgPeer.chatId });
        } else if (dlgPeer instanceof Api.PeerChannel) {
          const ch = result.chats.find((c: Api.TypeChat): c is Api.Channel => c instanceof Api.Channel && c.id.equals(dlgPeer.channelId));
          offsetPeer = new Api.InputPeerChannel({ channelId: dlgPeer.channelId, accessHash: ch?.accessHash ?? bigInt(0) });
        }
      } else {
        console.warn(`[enrich-chat-type] page=${page} topMessage not found, stopping early`);
        break;
      }
    }

    await sleep(Math.random() * 2500 + 1500);
  }

  console.log(`[enrich-chat-type] enumerated ${entries.length} dialogs across ${page} pages`);
  return entries;
}

async function applyUpdates(pool: Pool, accountId: string, entries: ChatTypeEntry[]): Promise<number> {
  if (entries.length === 0) return 0;

  // Single UNNEST UPDATE — one round trip regardless of entry count
  const { rowCount } = await pool.query(
    `UPDATE messages
     SET chat_type = v.chat_type
     FROM UNNEST($1::text[], $2::text[]) AS v(tg_chat_id, chat_type)
     WHERE messages.account_id = $3
       AND messages.tg_chat_id = v.tg_chat_id
       AND messages.chat_type IS NULL`,
    [
      entries.map(e => e.tg_chat_id),
      entries.map(e => e.chat_type),
      accountId,
    ],
  );
  return rowCount ?? 0;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const client = new TelegramClient(new StringSession(GRAMJS_SESSION), API_ID, API_HASH, {
    floodSleepThreshold: 300,
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  await client.connect();
  console.log('[enrich-chat-type] connected to Telegram');

  const me = await client.getMe();
  if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty — invalid session');
  const accountId = String(me.id);
  console.log(`[enrich-chat-type] account_id=${accountId}`);

  const entries = await enumerateDialogTypes(client);
  await client.disconnect();
  console.log('[enrich-chat-type] disconnected from Telegram');

  const updated = await applyUpdates(pool, accountId, entries);
  console.log(`[enrich-chat-type] updated ${updated} messages`);

  await pool.end();
}

main().catch(err => {
  console.error('[enrich-chat-type] fatal:', err);
  process.exit(1);
});
