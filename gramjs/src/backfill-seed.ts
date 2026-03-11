import bigInt from 'big-integer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { requireEnv, sleep } from './utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncConfig {
  sync_mode: 'all' | 'blacklist' | 'whitelist' | 'none';
  chatOverrides: ChatOverride[];
}

interface ChatOverride {
  tg_chat_id: string;
  sync: 'include' | 'exclude';
}

interface DialogSeedEntry {
  tg_chat_id: string;
  chat_name: string | null;
  total_messages: number | null;
}

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
// Sync config
// ---------------------------------------------------------------------------

async function fetchSyncConfig(): Promise<SyncConfig> {
  const headers = { 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID };
  const [globalRes, chatsRes] = await Promise.all([
    fetch(`${WORKER_URL}/config`, { headers }),
    fetch(`${WORKER_URL}/chats/config`, { headers }),
  ]);

  if (!globalRes.ok) {
    throw new Error(`GET /config failed: HTTP ${globalRes.status}`);
  }
  if (!chatsRes.ok) {
    throw new Error(`GET /chats/config failed: HTTP ${chatsRes.status}`);
  }

  const { sync_mode } = (await globalRes.json()) as { sync_mode: SyncConfig['sync_mode'] };
  const chatOverrides = (await chatsRes.json()) as ChatOverride[];
  return { sync_mode, chatOverrides };
}

function shouldSync(tgChatId: string, config: SyncConfig): boolean {
  switch (config.sync_mode) {
    case 'none':
      return false;
    case 'all':
      return true;
    case 'blacklist': {
      const override = config.chatOverrides.find(o => o.tg_chat_id === tgChatId);
      return override?.sync !== 'exclude';
    }
    case 'whitelist': {
      const override = config.chatOverrides.find(o => o.tg_chat_id === tgChatId);
      return override?.sync === 'include';
    }
  }
}

// ---------------------------------------------------------------------------
// Chat name resolution from Dialogs result
// ---------------------------------------------------------------------------

function resolveChatName(
  tg_chat_id: string,
  chat_type: string,
  result: Api.messages.Dialogs | Api.messages.DialogsSlice,
): string | null {
  if (chat_type === 'user') {
    const user = result.users.find(
      u => u instanceof Api.User && u.id.toString() === tg_chat_id,
    ) as Api.User | undefined;
    if (user) {
      return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || null;
    }
  } else {
    const chat = result.chats.find(
      c => 'id' in c && (c as unknown as { id: { toString(): string } }).id.toString() === tg_chat_id,
    ) as (Api.Chat | Api.Channel) | undefined;
    if (chat && 'title' in chat) {
      return (chat as { title: string }).title || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Peer to InputPeer conversion (for pagination offset)
// ---------------------------------------------------------------------------

function dlgToInputPeer(peer: Api.TypePeer): Api.TypeInputPeer {
  if (peer instanceof Api.PeerUser) {
    return new Api.InputPeerUser({ userId: peer.userId, accessHash: bigInt(0) });
  }
  if (peer instanceof Api.PeerChat) {
    return new Api.InputPeerChat({ chatId: peer.chatId });
  }
  if (peer instanceof Api.PeerChannel) {
    return new Api.InputPeerChannel({ channelId: peer.channelId, accessHash: bigInt(0) });
  }
  return new Api.InputPeerEmpty();
}

// ---------------------------------------------------------------------------
// Dialog enumeration
// ---------------------------------------------------------------------------

async function enumerateDialogs(
  client: TelegramClient,
  syncConfig: SyncConfig,
): Promise<DialogSeedEntry[]> {
  const dialogs: DialogSeedEntry[] = [];
  let offsetDate = 0;
  let offsetId = 0;
  let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
  const limit = 100;
  let page = 0;

  while (true) {
    page++;
    console.log(`[seed] fetching dialog page=${page} offset_id=${offsetId}`);

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
      result instanceof Api.messages.DialogsNotModified ||
      !(
        result instanceof Api.messages.Dialogs ||
        result instanceof Api.messages.DialogsSlice
      )
    ) {
      console.log(`[seed] dialogs exhausted (DialogsNotModified or unknown type) after page=${page}`);
      break;
    }

    const dlgs = result.dialogs;
    if (dlgs.length === 0) {
      console.log(`[seed] no more dialogs after page=${page}`);
      break;
    }

    let pageIncluded = 0;
    let pageSkipped = 0;

    for (const dlg of dlgs) {
      if (!(dlg instanceof Api.Dialog)) continue;

      const peer = dlg.peer;
      let tg_chat_id: string;
      let chat_type: string;

      if (peer instanceof Api.PeerUser) {
        tg_chat_id = String(peer.userId);
        chat_type = 'user';
      } else if (peer instanceof Api.PeerChat) {
        tg_chat_id = String(peer.chatId);
        chat_type = 'group';
      } else if (peer instanceof Api.PeerChannel) {
        tg_chat_id = String(peer.channelId);
        chat_type = 'channel';
      } else {
        continue;
      }

      if (!shouldSync(tg_chat_id, syncConfig)) {
        pageSkipped++;
        continue;
      }

      const chat_name = resolveChatName(tg_chat_id, chat_type, result);

      // total_messages: getDialogs does not expose a reliable total count.
      // Pass null — the Worker will accept it and the backfill-run script
      // will populate it from the first getHistory response.
      dialogs.push({ tg_chat_id, chat_name, total_messages: null });
      pageIncluded++;
    }

    console.log(
      `[seed] page=${page} included=${pageIncluded} skipped=${pageSkipped} cumulative=${dialogs.length}`,
    );

    // Full Dialogs (non-slice) means we got everything in one shot
    if (result instanceof Api.messages.Dialogs || dlgs.length < limit) {
      console.log(`[seed] last page reached`);
      break;
    }

    // Update offset for next page using the last dialog's top message
    const lastDlg = dlgs[dlgs.length - 1];
    if (lastDlg instanceof Api.Dialog) {
      const lastMsg = result.messages.find(m => m.id === lastDlg.topMessage);
      if (lastMsg && 'date' in lastMsg) {
        offsetDate = (lastMsg as { date: number }).date;
        offsetId = lastMsg.id;
      }
      offsetPeer = dlgToInputPeer(lastDlg.peer);
    }

    // Anti-ban: randomized sleep between pages (1.5–4s per CLAUDE.md)
    const ms = Math.random() * 2500 + 1500;
    await sleep(ms);
  }

  return dialogs;
}

// ---------------------------------------------------------------------------
// Seed Worker
// ---------------------------------------------------------------------------

async function seedWorker(dialogs: DialogSeedEntry[], accountId: string): Promise<void> {
  let seededTotal = 0;
  const batchSize = 100;

  for (let i = 0; i < dialogs.length; i += batchSize) {
    const batch = dialogs.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    try {
      const res = await fetch(`${WORKER_URL}/backfill/seed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ingest-Token': INGEST_TOKEN,
          'X-Account-ID': accountId,
        },
        body: JSON.stringify({ dialogs: batch }),
      });

      if (!res.ok) {
        console.error(`[seed] batch=${batchNum} HTTP ${res.status}`);
      } else {
        const { seeded } = (await res.json()) as { seeded: number };
        seededTotal += seeded;
        console.log(
          `[seed] batch=${batchNum} size=${batch.length} newly_seeded=${seeded} total_seeded=${seededTotal}`,
        );
      }
    } catch (err) {
      console.error(
        `[seed] batch=${batchNum} fetch error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(
    `[seed] done. dialogs_found=${dialogs.length} newly_seeded=${seededTotal}`,
  );
}

// ---------------------------------------------------------------------------
// Exported orchestration (used by backfill.ts)
// ---------------------------------------------------------------------------

export async function runSeed(client: TelegramClient, accountId: string): Promise<void> {
  const syncConfig = await fetchSyncConfigWith(accountId);
  console.log(`[seed] sync_mode=${syncConfig.sync_mode} overrides=${syncConfig.chatOverrides.length}`);

  const dialogs = await enumerateDialogs(client, syncConfig);
  console.log(`[seed] enumerated dialogs=${dialogs.length}`);

  await client.disconnect();
  console.log('[seed] disconnected from Telegram');

  await seedWorker(dialogs, accountId);
}

async function fetchSyncConfigWith(accountId: string): Promise<SyncConfig> {
  const headers = { 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': accountId };
  const [globalRes, chatsRes] = await Promise.all([
    fetch(`${WORKER_URL}/config`, { headers }),
    fetch(`${WORKER_URL}/chats/config`, { headers }),
  ]);
  if (!globalRes.ok) throw new Error(`GET /config failed: HTTP ${globalRes.status}`);
  if (!chatsRes.ok) throw new Error(`GET /chats/config failed: HTTP ${chatsRes.status}`);
  const { sync_mode } = (await globalRes.json()) as { sync_mode: SyncConfig['sync_mode'] };
  const chatOverrides = (await chatsRes.json()) as ChatOverride[];
  return { sync_mode, chatOverrides };
}

// ---------------------------------------------------------------------------
// Main (standalone use)
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
      console.error('[seed] AUTH_KEY_DUPLICATED — scale down the Fly listener first:\n  fly scale count 0 --yes -a <app>');
      process.exit(1);
    }
    throw err;
  }
  console.log('[seed] connected to Telegram');

  if (!ACCOUNT_ID) {
    const me = await client.getMe();
    if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty — session is invalid');
    ACCOUNT_ID = String(me.id);
  }
  console.log(`[seed] account_id=${ACCOUNT_ID}`);

  await runSeed(client, ACCOUNT_ID);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[seed] fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
