import * as fs from 'fs';
import bigInt from 'big-integer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import { DeletedMessage, DeletedMessageEvent } from 'telegram/events/DeletedMessage';
import { Api } from 'telegram';
import type { Message } from './types';
import { requireEnv, resolveSenderId, resolveMediaType, resolveMessageType } from './utils';

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
// Peer resolution
// ---------------------------------------------------------------------------

function resolvePeer(peerId: Api.TypePeer): { tg_chat_id: string; chat_type: string } {
  if (peerId instanceof Api.PeerUser) return { tg_chat_id: String(peerId.userId), chat_type: 'user' };
  if (peerId instanceof Api.PeerChat) return { tg_chat_id: String(peerId.chatId), chat_type: 'group' };
  if (peerId instanceof Api.PeerChannel) return { tg_chat_id: String(peerId.channelId), chat_type: 'channel' };
  throw new Error(`Unknown peer type: ${JSON.stringify(peerId)}`);
}

// ---------------------------------------------------------------------------
// Sync config
// ---------------------------------------------------------------------------

let syncConfig: SyncConfig = { sync_mode: 'all', chatOverrides: [] };

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
  const rawOverrides = (await chatsRes.json()) as ChatOverride[];
  const chatOverrides = rawOverrides.map(o => ({ ...o, tg_chat_id: normalizeChatId(o.tg_chat_id) }));
  return { sync_mode, chatOverrides };
}

// GramJS returns bare numeric IDs from MTProto (e.g. "1234567890").
// User-configured overrides may use the Bot API -100 prefix (e.g. "-1001234567890").
// Normalize to bare ID so comparisons are always consistent.
function normalizeChatId(id: string): string {
  if (id.startsWith('-100')) return id.slice(4); // supergroup/channel Bot API prefix
  if (id.startsWith('-')) return id.slice(1);    // plain negative basic group ID
  return id;
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
let flushing = false; // re-entrancy guard (L-2): prevents concurrent flushBuffer calls
const seenSenderIds = new Set<string>(); // dedup upsertSenderContact within session

async function flushBuffer(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  // Take first 100 with slice — messages stay in buffer until confirmed delivery
  const batch = buffer.slice(0, 100);
  try {
    const res = await fetch(`${WORKER_URL}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Token': INGEST_TOKEN,
        'X-Account-ID': ACCOUNT_ID,
      },
      body: JSON.stringify({ messages: batch }),
    });
    if (!res.ok) {
      // L-1: messages were never removed (slice), do NOT unshift — that would duplicate them
      console.error(`[ingest] HTTP ${res.status} for batch of ${batch.length} — will retry on next flush`);
    } else {
      // Only remove from buffer after confirmed delivery
      buffer.splice(0, batch.length);
      const { written, noop } = (await res.json()) as { written: number; noop: number };
      console.log(`[ingest] written=${written} noop=${noop} batch=${batch.length}`);
    }
  } catch (err) {
    // L-1: same — messages still in buffer, do NOT unshift
    console.error(`[ingest] fetch error:`, err instanceof Error ? err.message : String(err), '— will retry on next flush');
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

function mapMessage(raw: Api.Message): Message {
  const { tg_chat_id, chat_type: rawChatType } = resolvePeer(raw.peerId);
  // Supergroups are PeerChannel with megagroup=true — distinguish from broadcast channels
  const chat_type = (rawChatType === 'channel' && raw.chat instanceof Api.Channel && raw.chat.megagroup)
    ? 'supergroup'
    : rawChatType;
  const sender_id = resolveSenderId(raw.fromId);

  // Resolve chat name and sender details from event entities (populated by GramJS)
  let chat_name: string | undefined;
  let sender_username: string | undefined;
  let sender_first_name: string | undefined;
  let sender_last_name: string | undefined;

  const chatEntity = raw.chat;
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
  const senderEntity = raw.sender;
  if (senderEntity && 'username' in senderEntity) {
    const s = senderEntity as { username?: string; firstName?: string; lastName?: string };
    sender_username = s.username ?? undefined;
    sender_first_name = s.firstName ?? undefined;
    sender_last_name = s.lastName ?? undefined;
  }

  return {
    tg_message_id: String(raw.id), // S-1: always string — Telegram IDs are 64-bit
    tg_chat_id,
    chat_name,
    chat_type: chat_type as Message['chat_type'],
    sender_id,
    sender_username,
    sender_first_name,
    sender_last_name,
    direction: raw.out ? 'out' : (raw.fromId instanceof Api.PeerUser ? 'in' : undefined),
    message_type: resolveMessageType(raw),
    text: raw.message || undefined,
    media_type: resolveMediaType(raw.media ?? undefined),
    media_file_id: undefined,
    reply_to_message_id: raw.replyTo?.replyToMsgId ?? undefined,
    forwarded_from_id: raw.fwdFrom?.fromId ? resolveSenderId(raw.fwdFrom.fromId) : undefined,
    forwarded_from_name: raw.fwdFrom?.fromName ?? undefined,
    sent_at: raw.date, // already Unix epoch seconds — DO NOT call new Date()
    edit_date: raw.editDate ?? undefined,
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
    const result = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));

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
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
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
  if (seenSenderIds.has(msg.sender_id)) return;
  // L-8: add to seenSenderIds AFTER confirmed delivery so failed upserts are retried
  try {
    const res = await fetch(`${WORKER_URL}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
      body: JSON.stringify({
        contacts: [{
          tg_user_id: msg.sender_id,
          username: msg.sender_username,
          first_name: msg.sender_first_name,
          last_name: msg.sender_last_name,
        }],
      }),
    });
    if (res.ok) seenSenderIds.add(msg.sender_id);
  } catch {
    // Ignore — contact upsert is best-effort; will be retried on next message from this sender
  }
}

// ---------------------------------------------------------------------------
// Gap recovery (pts-based)
// ---------------------------------------------------------------------------

const STATE_FILE = '/data/state.json';

interface PtsState {
  pts: number;
  qts: number; // L-5: track qts alongside pts for GetDifference
}

async function loadPtsState(): Promise<PtsState | null> {
  try {
    const data = JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf-8')) as Partial<PtsState>;
    return data.pts ? { pts: data.pts, qts: data.qts ?? 0 } : null;
  } catch {
    return null;
  }
}

async function savePtsState(state: PtsState): Promise<void> {
  try {
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch (err) {
    console.error('[pts] failed to save state:', err instanceof Error ? err.message : String(err));
  }
}

function buildGapMessage(raw: Api.Message, chats: Api.TypeChat[], users: Api.TypeUser[]): Message {
  const { tg_chat_id, chat_type: rawChatType } = resolvePeer(raw.peerId);

  // L-6: resolve chat_name for all peer types, not just channels
  let chat_name: string | undefined;
  let chat_type = rawChatType;
  if (raw.peerId instanceof Api.PeerChannel) {
    const ch = chats.find((c): c is Api.Channel => c instanceof Api.Channel && String(c.id) === tg_chat_id);
    chat_name = ch?.title ?? undefined;
    chat_type = (rawChatType === 'channel' && ch?.megagroup) ? 'supergroup' : rawChatType;
  } else if (raw.peerId instanceof Api.PeerChat) {
    const ch = chats.find(c => 'id' in c && String((c as { id: { toString(): string } }).id) === tg_chat_id);
    chat_name = ch && 'title' in ch ? (ch as { title: string }).title : undefined;
  } else if (raw.peerId instanceof Api.PeerUser) {
    const u = users.find((u): u is Api.User => u instanceof Api.User && String(u.id) === tg_chat_id);
    if (u) chat_name = [u.firstName, u.lastName].filter(Boolean).join(' ') || undefined;
  }

  return {
    tg_message_id: String(raw.id), // S-1
    tg_chat_id,
    chat_type: chat_type as Message['chat_type'],
    chat_name,
    sender_id: resolveSenderId(raw.fromId),
    sender_username: undefined,
    sender_first_name: undefined,
    sender_last_name: undefined,
    direction: raw.out ? 'out' : (raw.fromId instanceof Api.PeerUser ? 'in' : undefined),
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
  const ptsState = await loadPtsState();
  if (!ptsState) {
    console.log('[gap-recovery] no saved pts, skipping');
    return;
  }
  console.log(`[gap-recovery] recovering from pts=${ptsState.pts} qts=${ptsState.qts}`);

  let currentPts = ptsState.pts;
  let currentQts = ptsState.qts; // L-5: carry real qts so Telegram returns correct secret-chat updates
  let totalMissed = 0;
  // Safety cap: 1000 iterations covers ~5 days of typical update volume
  const MAX_ITERATIONS = 1000;
  let iterations = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const result = await client.invoke(
        new Api.updates.GetDifference({ pts: currentPts, date: Math.floor(Date.now() / 1000), qts: currentQts }),
      );

      if (result instanceof Api.updates.DifferenceTooLong) {
        console.warn('[gap-recovery] DifferenceTooLong — pts too stale, resetting. Messages during gap are unrecoverable.');
        await flushBuffer(); // L-4: flush partial batch before exiting
        await persistPts(client);
        break;
      }

      if (result instanceof Api.updates.DifferenceEmpty) {
        console.log('[gap-recovery] up to date (DifferenceEmpty)');
        await flushBuffer(); // L-4
        break;
      }

      // Both Difference and DifferenceSlice have newMessages
      const messages = result.newMessages;
      totalMissed += messages.length;

      for (const raw of messages) {
        if (!(raw instanceof Api.Message)) continue;
        const gapMsg = buildGapMessage(raw, result.chats, result.users); // L-6: pass users
        if (!shouldSync(gapMsg.tg_chat_id, syncConfig)) continue;
        buffer.push(gapMsg);
        if (buffer.length >= 100) await flushBuffer();
      }

      if (result instanceof Api.updates.Difference) {
        // Final page — done
        await flushBuffer();
        console.log(`[gap-recovery] complete total_missed=${totalMissed}`);
        break;
      }

      // DifferenceSlice — more pages, advance pts and loop
      const newPts = result.intermediateState.pts;
      const newQts = result.intermediateState.qts;
      if (newPts === currentPts) {
        // pts didn't advance — Telegram API anomaly, break to avoid infinite loop
        console.error('[gap-recovery] pts stalled, aborting to prevent infinite loop');
        await flushBuffer(); // L-4: flush partial batch before exiting
        await savePtsState({ pts: currentPts, qts: currentQts });
        break;
      }
      currentPts = newPts;
      currentQts = newQts; // L-5: keep qts in sync
      await savePtsState({ pts: currentPts, qts: currentQts });
      console.log(`[gap-recovery] slice batch=${messages.length} next_pts=${currentPts}`);
    }
    if (iterations >= MAX_ITERATIONS) {
      console.error(`[gap-recovery] hit iteration cap (${MAX_ITERATIONS}), gap recovery incomplete`);
      await flushBuffer(); // L-4: flush whatever we collected before giving up
    }
  } catch (err) {
    console.error('[gap-recovery] error:', err instanceof Error ? err.message : String(err));
  }
}

async function persistPts(client: TelegramClient): Promise<void> {
  try {
    const state = await client.invoke(new Api.updates.GetState());
    await savePtsState({ pts: state.pts, qts: state.qts }); // L-5: persist both
  } catch {
    // ignore — state will be persisted on next tick
  }
}

// ---------------------------------------------------------------------------
// Outbox polling — send queued messages
// ---------------------------------------------------------------------------

interface OutboxRecipient {
  id: number;
  tg_chat_id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  status: string;
}

interface OutboxItem {
  id: number;
  tg_chat_id?: string;
  reply_to_message_id?: number;
  text: string;
  status: string;
  recipients?: OutboxRecipient[];
}

function renderTemplate(text: string, ctx: { first_name?: string; last_name?: string; username?: string }): string {
  const user = ctx.first_name ?? (ctx.username ? `@${ctx.username}` : 'there');
  return text
    .replace(/\{user\}/g, user)
    .replace(/\{first_name\}/g, ctx.first_name ?? '')
    .replace(/\{last_name\}/g, ctx.last_name ?? '')
    .replace(/\{username\}/g, ctx.username ?? '');
}

async function ackOutbox(
  id: number,
  status: 'sent' | 'failed' | 'partial',
  sentAt: number,
  error?: string,
  recipientResults?: Array<{ id: number; status: string; sent_at?: number; error?: string }>,
): Promise<void> {
  await fetch(`${WORKER_URL}/outbox/${id}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
    body: JSON.stringify({ status, sent_at: sentAt, error: error ?? null, results: recipientResults ?? null }),
  });
}

async function sendOutboxItem(client: TelegramClient, item: OutboxItem): Promise<void> {
  const sentAt = Math.floor(Date.now() / 1000);
  const replyTo = item.reply_to_message_id ? { replyToMsgId: item.reply_to_message_id } : {};

  // Single-chat send
  if (item.tg_chat_id) {
    try {
      await client.sendMessage(item.tg_chat_id, { message: item.text, ...replyTo });
      await ackOutbox(item.id, 'sent', sentAt);
      console.log(`[outbox] sent id=${item.id} chat=${item.tg_chat_id}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[outbox] failed id=${item.id}:`, errMsg);
      await ackOutbox(item.id, 'failed', sentAt, errMsg);
    }
    return;
  }

  // Mass send
  const recipients = item.recipients ?? [];
  const results: Array<{ id: number; status: string; sent_at?: number; error?: string }> = [];
  let failCount = 0;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const text = renderTemplate(item.text, { first_name: r.first_name, last_name: r.last_name, username: r.username });
    try {
      await client.sendMessage(r.tg_chat_id, { message: text });
      results.push({ id: r.id, status: 'sent', sent_at: Math.floor(Date.now() / 1000) });
      console.log(`[outbox] mass id=${item.id} sent to ${r.tg_chat_id}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[outbox] mass id=${item.id} failed for ${r.tg_chat_id}:`, errMsg);
      results.push({ id: r.id, status: 'failed', error: errMsg });
      failCount++;
    }
    // 2–5s jitter between recipients to avoid flood
    if (i < recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
    }
  }

  const finalStatus = failCount === 0 ? 'sent' : failCount === recipients.length ? 'failed' : 'partial';
  await ackOutbox(item.id, finalStatus, sentAt, undefined, results);
}

async function pollOutbox(client: TelegramClient): Promise<void> {
  try {
    const res = await fetch(`${WORKER_URL}/outbox/due`, {
      headers: { 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
    });
    if (!res.ok) { console.error(`[outbox] poll failed: HTTP ${res.status}`); return; }
    const items = (await res.json()) as OutboxItem[];
    if (items.length === 0) return;
    console.log(`[outbox] claimed ${items.length} item(s)`);
    for (const item of items) {
      await sendOutboxItem(client, item);
    }
  } catch (err) {
    console.error('[outbox] poll error:', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Pending actions — edit / delete / forward
// ---------------------------------------------------------------------------

interface PendingAction {
  id: number;
  action: 'edit' | 'delete' | 'forward';
  tg_chat_id: string;
  tg_message_id: string;
  text?: string;
  to_chat_id?: string;
}

async function ackAction(id: number, status: 'done' | 'failed', error?: string): Promise<void> {
  await fetch(`${WORKER_URL}/actions/${id}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
    body: JSON.stringify({ status, error: error ?? null }),
  });
}

async function processAction(client: TelegramClient, action: PendingAction): Promise<void> {
  const msgId = parseInt(action.tg_message_id, 10);
  try {
    if (action.action === 'edit') {
      // High-level editMessage resolves the entity string internally
      await client.editMessage(action.tg_chat_id, {
        message: msgId,
        text: action.text ?? '',
      });
      // EditedMessage event fires naturally → archive updated with correct sent_at
      console.log(`[actions] edited msg=${msgId} chat=${action.tg_chat_id}`);
    } else if (action.action === 'delete') {
      // High-level deleteMessages handles both regular chats and channels
      await client.deleteMessages(action.tg_chat_id, [msgId], { revoke: true });
      // Notify worker to mark as deleted
      await fetch(`${WORKER_URL}/deleted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
        body: JSON.stringify({ messages: [{ tg_chat_id: action.tg_chat_id, tg_message_id: action.tg_message_id }] }),
      });
      console.log(`[actions] deleted msg=${msgId} chat=${action.tg_chat_id}`);
    } else if (action.action === 'forward') {
      // Low-level ForwardMessages requires InputPeer — resolve via getInputEntity first
      const fromPeer = await client.getInputEntity(action.tg_chat_id);
      const toPeer = await client.getInputEntity(action.to_chat_id!);
      await client.invoke(new Api.messages.ForwardMessages({
        fromPeer,
        id: [msgId],
        toPeer,
        randomId: [bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))],
      }));
      console.log(`[actions] forwarded msg=${msgId} from=${action.tg_chat_id} to=${action.to_chat_id}`);
    }
    await ackAction(action.id, 'done');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[actions] ${action.action} failed id=${action.id}:`, errMsg);
    await ackAction(action.id, 'failed', errMsg);
  }
}

async function pollActions(client: TelegramClient): Promise<void> {
  try {
    const res = await fetch(`${WORKER_URL}/actions/pending`, {
      headers: { 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
    });
    if (!res.ok) { console.error(`[actions] poll failed: HTTP ${res.status}`); return; }
    const actions = (await res.json()) as PendingAction[];
    if (actions.length === 0) return;
    console.log(`[actions] processing ${actions.length} pending action(s)`);
    for (const action of actions) {
      await processAction(client, action);
    }
  } catch (err) {
    console.error('[actions] poll error:', err instanceof Error ? err.message : String(err));
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

  // 2b. Derive account ID — always numeric Telegram user ID, never username
  if (!ACCOUNT_ID) {
    const me = await client.getMe();
    if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty — session is invalid');
    ACCOUNT_ID = String(me.id);
    // Register username alias so the worker can resolve e.g. "d4d0ch" → "7926042351"
    if (me.username) {
      try {
        await fetch(`${WORKER_URL}/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
          body: JSON.stringify({ username: me.username }),
        });
      } catch {
        // Non-fatal — listener works without it
      }
    }
  }
  console.log(`[listener] account_id=${ACCOUNT_ID}`);

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

  async function enqueue(msg: Message): Promise<void> {
    if (!shouldSync(msg.tg_chat_id, syncConfig)) return;
    buffer.push(msg);
    if (buffer.length >= 100) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushBuffer();
    } else {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { void flushBuffer(); }, 2000);
    }
  }

  // 6. Register message event handlers
  client.addEventHandler(async (event: NewMessageEvent) => {
    const raw = event.message;
    if (!(raw instanceof Api.Message)) return;
    const msg = mapMessage(raw);
    if (msg.sender_id) void upsertSenderContact(msg);
    await enqueue(msg);
  }, new NewMessage({}));

  // EditedMessage: re-ingest with edit_date set; Worker ON CONFLICT preserves original_text
  client.addEventHandler(async (event: EditedMessageEvent) => {
    const raw = event.message;
    if (!(raw instanceof Api.Message)) return;
    await enqueue(mapMessage(raw));
  }, new EditedMessage({}));

  console.log('[listener] NewMessage + EditedMessage handlers registered');

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

    const messages = event.deletedIds.map((id: number) => ({ tg_chat_id, tg_message_id: String(id) })); // S-1
    try {
      await fetch(`${WORKER_URL}/deleted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': INGEST_TOKEN, 'X-Account-ID': ACCOUNT_ID },
        body: JSON.stringify({ messages }),
      });
    } catch (err) {
      console.error('[listener] DELETE notify failed:', err instanceof Error ? err.message : String(err));
    }
  }, new DeletedMessage({}));

  // Persist pts every minute so gap recovery stays fresh
  const ptsInterval = setInterval(() => {
    void persistPts(client);
  }, 60_000);

  // Refresh sync config every 5 minutes
  const configInterval = setInterval(() => {
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

  // Poll outbox (pending/scheduled) every 30 seconds
  const outboxInterval = setInterval(() => { void pollOutbox(client); }, 30_000);

  // Poll pending actions (edit/delete/forward) every 30 seconds
  const actionsInterval = setInterval(() => { void pollActions(client); }, 30_000);

  // 6. Graceful shutdown on SIGTERM (Fly sends this before killing the container)
  process.on('SIGTERM', () => {
    console.log('[listener] SIGTERM received, flushing buffer and exiting');
    if (flushTimer) clearTimeout(flushTimer);
    clearInterval(ptsInterval);
    clearInterval(configInterval);
    clearInterval(outboxInterval);
    clearInterval(actionsInterval);
    // Drain entire buffer (flushBuffer only takes 100 at a time), with a 4s deadline
    const drainAndExit = async () => {
      const deadline = new Promise<void>(resolve => setTimeout(resolve, 4000));
      const drain = async () => { while (buffer.length > 0) await flushBuffer(); };
      await Promise.race([drain(), deadline]);
      await client.disconnect().catch(() => {});
      process.exit(0);
    };
    void drainAndExit();
  });

  // 7. Keep process alive indefinitely
  await new Promise<never>(() => {});
}

main().catch((err: unknown) => {
  console.error('[listener] fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

