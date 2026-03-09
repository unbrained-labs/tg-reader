import * as fs from 'fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent, EditedMessage, EditedMessageEvent, DeletedMessage, DeletedMessageEvent } from 'telegram/events';
import { Api } from 'telegram';
import type { Message } from './types';

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

// ---------------------------------------------------------------------------
// Environment — fail fast if any required var is missing
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const GRAMJS_SESSION = requireEnv('GRAMJS_SESSION');
const API_ID_STR = requireEnv('API_ID');
const API_HASH = requireEnv('API_HASH');
const INGEST_TOKEN = requireEnv('INGEST_TOKEN');
const WORKER_URL = requireEnv('WORKER_URL');

const API_ID = parseInt(API_ID_STR, 10);
if (isNaN(API_ID)) {
  throw new Error(`API_ID must be a valid integer, got: ${API_ID_STR}`);
}

// ---------------------------------------------------------------------------
// Peer resolution helpers
// ---------------------------------------------------------------------------

function resolvePeer(peerId: Api.TypePeer): { tg_chat_id: string; chat_type: string } {
  if (peerId instanceof Api.PeerUser) {
    return { tg_chat_id: String(peerId.userId), chat_type: 'user' };
  } else if (peerId instanceof Api.PeerChat) {
    return { tg_chat_id: String(peerId.chatId), chat_type: 'group' };
  } else if (peerId instanceof Api.PeerChannel) {
    // Could be supergroup or channel — use 'channel' as default
    return { tg_chat_id: String(peerId.channelId), chat_type: 'channel' };
  }
  throw new Error(`Unknown peer type: ${JSON.stringify(peerId)}`);
}

function resolveSenderId(fromId: Api.TypePeer | null | undefined): string | undefined {
  if (!fromId) return undefined;
  if (fromId instanceof Api.PeerUser) return String(fromId.userId);
  if (fromId instanceof Api.PeerChat) return String(fromId.chatId);
  if (fromId instanceof Api.PeerChannel) return String(fromId.channelId);
  return undefined;
}

// ---------------------------------------------------------------------------
// Media type resolution
// ---------------------------------------------------------------------------

function resolveMediaType(media: Api.TypeMessageMedia | null | undefined): string | undefined {
  if (!media) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return 'photo';
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    if (doc instanceof Api.Document) {
      for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeVideo) return 'video';
        if (attr instanceof Api.DocumentAttributeAudio) {
          return (attr as Api.DocumentAttributeAudio).voice ? 'voice' : 'audio';
        }
        if (attr instanceof Api.DocumentAttributeSticker) return 'sticker';
        if (attr instanceof Api.DocumentAttributeAnimated) return 'gif';
      }
    }
    return 'document';
  }
  if (media instanceof Api.MessageMediaGeo) return 'location';
  if (media instanceof Api.MessageMediaContact) return 'contact';
  if (media instanceof Api.MessageMediaPoll) return 'poll';
  if (media instanceof Api.MessageMediaDice) return 'dice';
  return 'other';
}

// ---------------------------------------------------------------------------
// Message type resolution
// ---------------------------------------------------------------------------

function resolveMessageType(msg: Api.Message): string {
  if (msg.media) return resolveMediaType(msg.media) ?? 'media';
  if (msg.message) return 'text';
  return 'service';
}

// ---------------------------------------------------------------------------
// Sync config
// ---------------------------------------------------------------------------

let syncConfig: SyncConfig = { sync_mode: 'all', chatOverrides: [] };

async function fetchSyncConfig(): Promise<SyncConfig> {
  const headers = { 'X-Ingest-Token': INGEST_TOKEN };
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
// Ingest buffer
// ---------------------------------------------------------------------------

let buffer: Message[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, 100);
  try {
    const res = await fetch(`${WORKER_URL}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Token': INGEST_TOKEN,
      },
      body: JSON.stringify({ messages: batch }),
    });
    if (!res.ok) {
      console.error(`[ingest] HTTP ${res.status} for batch of ${batch.length}`);
    } else {
      const { inserted, skipped } = (await res.json()) as { inserted: number; skipped: number };
      console.log(`[ingest] inserted=${inserted} skipped=${skipped} batch=${batch.length}`);
    }
  } catch (err) {
    console.error(`[ingest] fetch error:`, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

function mapMessage(event: NewMessageEvent): Message | null {
  const msg = event.message;
  if (!(msg instanceof Api.Message)) return null; // skip MessageService etc.

  const { tg_chat_id, chat_type } = resolvePeer(msg.peerId);
  const sender_id = resolveSenderId(msg.fromId);

  // Resolve chat name and sender details from event entities (populated by GramJS)
  let chat_name: string | undefined;
  let sender_username: string | undefined;
  let sender_first_name: string | undefined;
  let sender_last_name: string | undefined;

  const chatEntity = msg.chat;
  if (chatEntity) {
    if ('title' in chatEntity) {
      chat_name = (chatEntity as { title?: string }).title ?? undefined;
    } else if ('firstName' in chatEntity || 'lastName' in chatEntity) {
      const u = chatEntity as { firstName?: string; lastName?: string; username?: string };
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ');
      chat_name = fullName || undefined;
      sender_username = u.username ?? undefined;
      sender_first_name = u.firstName ?? undefined;
      sender_last_name = u.lastName ?? undefined;
    }
  }

  // Sender entity (more specific than chat for direct messages)
  const senderEntity = msg.sender;
  if (senderEntity && 'username' in senderEntity) {
    const s = senderEntity as { username?: string; firstName?: string; lastName?: string };
    sender_username = s.username ?? undefined;
    sender_first_name = s.firstName ?? undefined;
    sender_last_name = s.lastName ?? undefined;
  }

  const forwarded_from_id = msg.fwdFrom?.fromId
    ? resolveSenderId(msg.fwdFrom.fromId)
    : undefined;

  return {
    tg_message_id: msg.id,
    tg_chat_id,
    chat_name,
    chat_type: chat_type as Message['chat_type'],
    sender_id,
    sender_username,
    sender_first_name,
    sender_last_name,
    direction: msg.out ? 'out' : 'in',
    message_type: resolveMessageType(msg),
    text: msg.message || undefined,
    media_type: resolveMediaType(msg.media ?? undefined),
    media_file_id: undefined,
    reply_to_message_id: msg.replyTo?.replyToMsgId ?? undefined,
    forwarded_from_id,
    forwarded_from_name: msg.fwdFrom?.fromName ?? undefined,
    sent_at: msg.date, // already Unix epoch seconds — DO NOT call new Date()
    edit_date: msg.editDate ?? undefined,
    is_deleted: 0,
    deleted_at: undefined,
  };
}

// ---------------------------------------------------------------------------
// Contacts sync
// ---------------------------------------------------------------------------

async function syncContacts(client: TelegramClient): Promise<void> {
  console.log('[contacts] syncing contacts list...');
  try {
    const result = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));

    if (!(result instanceof Api.contacts.Contacts)) {
      console.log('[contacts] no contacts or not modified');
      return;
    }

    const contacts = result.users
      .filter((u): u is Api.User => u instanceof Api.User)
      .map(u => ({
        tg_user_id: String(u.id),
        phone: u.phone ?? undefined,
        username: u.username ?? undefined,
        first_name: u.firstName ?? undefined,
        last_name: u.lastName ?? undefined,
        is_mutual: u.mutualContact ? 1 : 0,
        is_bot: u.bot ? 1 : 0,
      }));

    if (contacts.length === 0) {
      console.log('[contacts] no contacts to sync');
      return;
    }

    // POST in batches of 100
    let upserted = 0;
    for (let i = 0; i < contacts.length; i += 100) {
      const batch = contacts.slice(i, i + 100);
      const res = await fetch(`${WORKER_URL}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN },
        body: JSON.stringify({ contacts: batch }),
      });
      if (res.ok) {
        const data = await res.json() as { upserted: number };
        upserted += data.upserted;
      } else {
        console.error(`[contacts] POST /contacts HTTP ${res.status}`);
      }
    }
    console.log(`[contacts] synced count=${contacts.length} upserted=${upserted}`);
  } catch (err) {
    console.error('[contacts] sync failed:', err instanceof Error ? err.message : String(err));
    // Non-fatal — listener continues without contact data
  }
}

async function upsertSenderContact(msg: Message): Promise<void> {
  if (!msg.sender_id) return;
  try {
    await fetch(`${WORKER_URL}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN },
      body: JSON.stringify({
        contacts: [{
          tg_user_id: msg.sender_id,
          username: msg.sender_username,
          first_name: msg.sender_first_name,
          last_name: msg.sender_last_name,
        }],
      }),
    });
  } catch {
    // Ignore — contact upsert is best-effort
  }
}

// ---------------------------------------------------------------------------
// Gap recovery (pts-based)
// ---------------------------------------------------------------------------

const STATE_FILE = '/data/state.json';

function loadPts(): number | null {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as { pts?: number };
    return data.pts ?? null;
  } catch {
    return null;
  }
}

function savePts(pts: number): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pts }), 'utf-8');
  } catch (err) {
    console.error('[pts] failed to save pts:', err instanceof Error ? err.message : String(err));
  }
}

function buildGapMessage(raw: Api.Message): Message {
  const { tg_chat_id, chat_type } = resolvePeer(raw.peerId);
  return {
    tg_message_id: raw.id,
    tg_chat_id,
    chat_type: chat_type as Message['chat_type'],
    chat_name: undefined,
    sender_id: resolveSenderId(raw.fromId),
    sender_username: undefined,
    sender_first_name: undefined,
    sender_last_name: undefined,
    direction: raw.out ? 'out' : 'in',
    message_type: resolveMessageType(raw),
    text: raw.message || undefined,
    media_type: resolveMediaType(raw.media ?? undefined),
    media_file_id: undefined,
    reply_to_message_id: raw.replyTo?.replyToMsgId ?? undefined,
    forwarded_from_id: raw.fwdFrom?.fromId ? resolveSenderId(raw.fwdFrom.fromId) : undefined,
    forwarded_from_name: raw.fwdFrom?.fromName ?? undefined,
    sent_at: raw.date,
    edit_date: raw.editDate ?? undefined,
    is_deleted: 0,
    deleted_at: undefined,
  };
}

async function runGapRecovery(client: TelegramClient): Promise<void> {
  const pts = loadPts();
  if (!pts) {
    console.log('[gap-recovery] no saved pts, skipping');
    return;
  }
  console.log(`[gap-recovery] recovering from pts=${pts}`);

  let currentPts = pts;
  let totalMissed = 0;

  try {
    while (true) {
      const result = await client.invoke(
        new Api.updates.GetDifference({ pts: currentPts, date: 0, qts: 0 }),
      );

      if (result instanceof Api.updates.DifferenceTooLong) {
        console.warn('[gap-recovery] DifferenceTooLong — pts too stale, resetting. Messages during gap are unrecoverable.');
        await persistPts(client);
        break;
      }

      if (result instanceof Api.updates.DifferenceEmpty) {
        console.log('[gap-recovery] up to date (DifferenceEmpty)');
        break;
      }

      // Both Difference and DifferenceSlice have newMessages
      const messages = result.newMessages;
      totalMissed += messages.length;

      for (const raw of messages) {
        if (!(raw instanceof Api.Message)) continue;
        buffer.push(buildGapMessage(raw));
        if (buffer.length >= 100) await flushBuffer();
      }

      if (result instanceof Api.updates.Difference) {
        // Final page — done
        await flushBuffer();
        console.log(`[gap-recovery] complete total_missed=${totalMissed}`);
        break;
      }

      // DifferenceSlice — more pages, advance pts and loop
      currentPts = result.intermediateState.pts;
      console.log(`[gap-recovery] slice batch=${messages.length} next_pts=${currentPts}`);
    }
  } catch (err) {
    console.error('[gap-recovery] error:', err instanceof Error ? err.message : String(err));
  }
}

async function persistPts(client: TelegramClient): Promise<void> {
  try {
    const state = await client.invoke(new Api.updates.GetState());
    savePts(state.pts);
  } catch {
    // ignore — pts will be persisted on next tick
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Initialise client with existing StringSession (no interactive auth)
  const session = new StringSession(GRAMJS_SESSION);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    floodSleepThreshold: 300,
    autoReconnect: true,
    connectionRetries: 5,   // exhaust retries → exit → Fly restarts → gap recovery picks up
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  // 2. Connect (session already exists — do not use client.start())
  await client.connect();
  console.log('[listener] connected to Telegram');

  // 3. Fetch sync config from Worker
  try {
    syncConfig = await fetchSyncConfig();
    console.log(`[config] sync_mode=${syncConfig.sync_mode} overrides=${syncConfig.chatOverrides.length}`);
  } catch (err) {
    console.error(
      '[config] failed to fetch on startup:',
      err instanceof Error ? err.message : String(err),
    );
    // Continue with default 'all' — better to over-capture than drop messages
  }

  // 4. Gap recovery — then immediately persist pts baseline
  await runGapRecovery(client);
  await persistPts(client); // establish baseline before first 60s interval

  // 5. Sync contacts (non-fatal if it fails)
  await syncContacts(client);

  // 6. Register NewMessage event handler
  client.addEventHandler(async (event: NewMessageEvent) => {
    const msg = mapMessage(event);
    if (!msg) return;

    // Upsert sender into contacts (basic info — won't overwrite phone/is_mutual)
    if (msg.sender_id) {
      void upsertSenderContact(msg);
    }

    if (!shouldSync(msg.tg_chat_id, syncConfig)) return;

    buffer.push(msg);

    if (buffer.length >= 100) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flushBuffer();
    } else {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        void flushBuffer();
      }, 2000);
    }
  }, new NewMessage({}));

  console.log('[listener] NewMessage handler registered');

  // EditedMessage: re-ingest with edit_date set; Worker ON CONFLICT preserves original_text
  client.addEventHandler(async (event: EditedMessageEvent) => {
    const msg = mapMessage(event as unknown as NewMessageEvent);
    if (!msg) return;
    if (!shouldSync(msg.tg_chat_id, syncConfig)) return;
    buffer.push(msg);
    if (buffer.length >= 100) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushBuffer();
    } else {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { void flushBuffer(); }, 2000);
    }
  }, new EditedMessage({}));

  // DeletedMessage: mark as deleted in D1 — peer available for channels/supergroups only
  client.addEventHandler(async (event: DeletedMessageEvent) => {
    const peer = (event as unknown as { peer?: Api.TypePeer }).peer;
    if (!peer || event.deletedIds.length === 0) return; // private chat deletes have no peer context

    let tg_chat_id: string;
    try {
      ({ tg_chat_id } = resolvePeer(peer));
    } catch {
      return;
    }

    const messages = event.deletedIds.map(id => ({ tg_chat_id, tg_message_id: id }));
    try {
      await fetch(`${WORKER_URL}/deleted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN },
        body: JSON.stringify({ messages }),
      });
    } catch (err) {
      console.error('[listener] DELETE notify failed:', err instanceof Error ? err.message : String(err));
    }
  }, new DeletedMessage({}));

  // Persist pts every minute so gap recovery stays fresh
  setInterval(() => {
    void persistPts(client);
  }, 60_000);

  // Watchdog: reconnect if dropped, exit if reconnect fails (Fly restarts + gap recovery takes over)
  const watchdogInterval = setInterval(async () => {
    if (client.disconnected) {
      console.warn('[listener] disconnected, attempting reconnect...');
      try {
        await client.connect();
        console.log('[listener] reconnected');
      } catch (err) {
        console.error('[listener] reconnect failed, exiting for restart:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
  }, 30_000);

  // Refresh sync config every 5 minutes
  setInterval(() => {
    fetchSyncConfig()
      .then(cfg => {
        syncConfig = cfg;
        console.log(`[config] refreshed sync_mode=${cfg.sync_mode} overrides=${cfg.chatOverrides.length}`);
      })
      .catch(err =>
        console.error(
          '[config] refresh failed:',
          err instanceof Error ? err.message : String(err),
        ),
      );
  }, 5 * 60 * 1000);

  // 6. Graceful shutdown on SIGTERM (Fly sends this before killing the container)
  process.on('SIGTERM', () => {
    console.log('[listener] SIGTERM received, flushing buffer and exiting');
    clearInterval(watchdogInterval);
    if (flushTimer) clearTimeout(flushTimer);
    flushBuffer().finally(() => process.exit(0));
  });

  // 7. Keep process alive indefinitely
  await new Promise<never>(() => {});
}

main().catch((err: unknown) => {
  console.error('[listener] fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
