/**
 * enrich-senders.ts — one-time migration to fill sender_username / sender_first_name /
 * sender_last_name for messages backfilled before entity resolution was implemented.
 *
 * Uses getParticipants() per group/supergroup — the only way to reliably resolve
 * group members without per-user API calls. Direct Neon connection for the UPDATE.
 *
 * Run once:  npx ts-node src/enrich-senders.ts
 * Safe to re-run — uses COALESCE so already-filled rows are not touched.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';
import { Pool } from 'pg';
import { requireEnv } from './utils';

const GRAMJS_SESSION = requireEnv('GRAMJS_SESSION');
const API_ID = parseInt(requireEnv('API_ID'), 10);
const API_HASH = requireEnv('API_HASH');
const DATABASE_URL = requireEnv('DATABASE_URL');

if (isNaN(API_ID)) throw new Error('API_ID must be a valid integer');

type SenderInfo = { sender_id: string; username?: string; first_name?: string; last_name?: string };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getChatsWithUnresolved(pool: Pool, accountId: string) {
  const { rows } = await pool.query<{ tg_chat_id: string; chat_name: string; unresolved: string }>(
    `SELECT tg_chat_id, MAX(chat_name) AS chat_name, COUNT(DISTINCT sender_id) AS unresolved
     FROM messages
     WHERE account_id = $1
       AND sender_id IS NOT NULL
       AND sender_username IS NULL
       AND sender_first_name IS NULL
       AND sender_id NOT LIKE '-%'
     GROUP BY tg_chat_id
     ORDER BY unresolved DESC`,
    [accountId],
  );
  return rows.map(r => ({ tg_chat_id: r.tg_chat_id, chat_name: r.chat_name, unresolved: parseInt(r.unresolved, 10) }));
}

async function getSenderIdsForChat(pool: Pool, accountId: string, chatId: string): Promise<string[]> {
  const { rows } = await pool.query<{ sender_id: string }>(
    `SELECT DISTINCT sender_id FROM messages
     WHERE account_id = $1 AND tg_chat_id = $2
       AND sender_id IS NOT NULL AND sender_username IS NULL AND sender_first_name IS NULL
       AND sender_id NOT LIKE '-%'`,
    [accountId, chatId],
  );
  return rows.map(r => r.sender_id);
}

async function applyUpdates(pool: Pool, accountId: string, senders: SenderInfo[]): Promise<void> {
  if (senders.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of senders) {
      await client.query(
        `UPDATE messages
         SET sender_username   = COALESCE($1, sender_username),
             sender_first_name = COALESCE($2, sender_first_name),
             sender_last_name  = COALESCE($3, sender_last_name)
         WHERE account_id = $4 AND sender_id = $5
           AND sender_username IS NULL AND sender_first_name IS NULL`,
        [s.username ?? null, s.first_name ?? null, s.last_name ?? null, accountId, s.sender_id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const tgClient = new TelegramClient(new StringSession(GRAMJS_SESSION), API_ID, API_HASH, {
    floodSleepThreshold: 300,
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  await tgClient.connect();
  console.log('[enrich] connected to Telegram');

  const me = await tgClient.getMe();
  if (!(me instanceof Api.User)) throw new Error('getMe() returned UserEmpty — invalid session');
  const accountId = String(me.id);
  console.log(`[enrich] account_id=${accountId}`);

  const chats = await getChatsWithUnresolved(pool, accountId);
  const totalIds = chats.reduce((s, c) => s + c.unresolved, 0);
  console.log(`[enrich] ${chats.length} chats, ${totalIds} unresolved sender_ids`);

  let totalResolved = 0;
  let totalSkipped = 0;

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    console.log(`[enrich] [${i + 1}/${chats.length}] "${chat.chat_name}" — ${chat.unresolved} senders`);

    // Build entity map via getParticipants (includes access hashes for all members).
    // Channels/supergroups are stored as positive IDs (e.g. 2175027165) but GramJS
    // needs them in -100 prefix form (e.g. -1002175027165) to resolve as a channel peer.
    const entityMap = new Map<string, SenderInfo>();
    const numId = parseInt(chat.tg_chat_id, 10);
    // Positive IDs > 1e9 are almost always supergroups/channels — try -100 prefix first
    const peersToTry = !isNaN(numId) && numId > 0
      ? [`-100${chat.tg_chat_id}`, chat.tg_chat_id]
      : [chat.tg_chat_id];

    let participantsFetched = false;
    for (const peer of peersToTry) {
      try {
        const participants = await tgClient.getParticipants(peer, { limit: 0 });
        for (const p of participants) {
          if (p instanceof Api.User) {
            entityMap.set(String(p.id), {
              sender_id: String(p.id),
              username: p.username ?? undefined,
              first_name: p.firstName ?? undefined,
              last_name: p.lastName ?? undefined,
            });
          }
        }
        console.log(`[enrich]   getParticipants(${peer}) → ${entityMap.size} entities`);
        participantsFetched = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (peer === peersToTry[peersToTry.length - 1]) {
          console.log(`[enrich]   getParticipants failed (${msg})`);
        }
      }
    }
    void participantsFetched; // used only for logging

    const senderIds = await getSenderIdsForChat(pool, accountId, chat.tg_chat_id);
    const resolved: SenderInfo[] = [];

    for (const id of senderIds) {
      const cached = entityMap.get(id);
      if (cached) {
        resolved.push(cached);
        continue;
      }
      // Fallback: direct entity lookup (works for contacts / recently seen users)
      try {
        const entity = await tgClient.getEntity(id);
        if (entity instanceof Api.User) {
          resolved.push({
            sender_id: id,
            username: entity.username ?? undefined,
            first_name: entity.firstName ?? undefined,
            last_name: entity.lastName ?? undefined,
          });
        } else {
          const title = (entity as { title?: string }).title;
          if (title) resolved.push({ sender_id: id, first_name: title });
          else totalSkipped++;
        }
      } catch {
        totalSkipped++;
      }
    }

    await applyUpdates(pool, accountId, resolved);
    totalResolved += resolved.length;
    console.log(`[enrich]   applied ${resolved.length}/${senderIds.length}`);

    if (i + 1 < chats.length) await sleep(1500);
  }

  console.log(`[enrich] done. resolved=${totalResolved} skipped=${totalSkipped}`);

  await tgClient.disconnect();
  await pool.end();
}

main().catch(err => {
  console.error('[enrich] fatal:', err);
  process.exit(1);
});
