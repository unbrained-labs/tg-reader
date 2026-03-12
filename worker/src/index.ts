import { Pool } from '@neondatabase/serverless';
import type { Env, Message } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getPool(env: Env): Pool {
  return new Pool({ connectionString: env.HYPERDRIVE.connectionString });
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

// W-3: constant-time token comparison to prevent timing side-channel attacks.
// Signs both strings with HMAC-SHA256 using a fresh ephemeral key, then XORs
// the fixed-length digests — the loop always runs the same number of iterations.
async function timingSafeTokenEqual(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  // Length is not secret (token length is fixed), but we still guard it
  if (a.byteLength !== b.byteLength) return false;
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  ) as CryptoKey;
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, a),
    crypto.subtle.sign('HMAC', key, b),
  ]);
  const va = new Uint8Array(sigA);
  const vb = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// W-1/W-3: timing-safe token check. tokenOverride lets /mcp pass a query-string token
// for claude.ai connectors, which embed credentials in the URL (no custom header support).
async function authenticate(request: Request, env: Env, tokenOverride?: string | null): Promise<Response | null> {
  const token = tokenOverride ?? request.headers.get('X-Ingest-Token');
  if (!token || !(await timingSafeTokenEqual(token, env.INGEST_TOKEN))) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleIngest(request: Request, env: Env, accountId: string): Promise<Response> {
  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  // Validate messages array
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).messages)
  ) {
    return json({ ok: false, error: 'Body must be { messages: Message[] }' }, 400);
  }

  const messages = (body as { messages: unknown[] }).messages;

  if (messages.length < 1 || messages.length > 100) {
    return json(
      { ok: false, error: 'messages array must have 1–100 items' },
      400,
    );
  }

  // Validate required fields on each message (S-1: tg_message_id is now string)
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown>;
    if (typeof m.tg_message_id !== 'string' || typeof m.tg_chat_id !== 'string' || typeof m.sent_at !== 'number') {
      return json({ ok: false, error: `messages[${i}] missing required fields: tg_message_id (string), tg_chat_id (string), sent_at (number)` }, 400);
    }
  }

  console.log(`[POST /ingest] account=${accountId} count=${messages.length}`);

  // Single UNNEST INSERT — one round trip for up to 100 messages.
  // $1 = account_id scalar; $2–$21 = per-column arrays in message order.
  const SQL = `
    INSERT INTO messages (
      account_id, tg_message_id, tg_chat_id, chat_name, chat_type,
      sender_id, sender_username, sender_first_name, sender_last_name,
      direction, message_type, text, media_type, media_file_id,
      reply_to_message_id, forwarded_from_id, forwarded_from_name,
      sent_at, edit_date, is_deleted, deleted_at
    )
    SELECT $1,
      v.tg_message_id, v.tg_chat_id, v.chat_name, v.chat_type,
      v.sender_id, v.sender_username, v.sender_first_name, v.sender_last_name,
      v.direction, v.message_type, v.text, v.media_type, v.media_file_id,
      v.reply_to_message_id, v.forwarded_from_id, v.forwarded_from_name,
      v.sent_at, v.edit_date, v.is_deleted, v.deleted_at
    FROM UNNEST(
      $2::text[], $3::text[], $4::text[], $5::text[],
      $6::text[], $7::text[], $8::text[], $9::text[],
      $10::text[], $11::text[], $12::text[], $13::text[], $14::text[],
      $15::bigint[], $16::text[], $17::text[],
      $18::bigint[], $19::bigint[], $20::smallint[], $21::bigint[]
    ) AS v(
      tg_message_id, tg_chat_id, chat_name, chat_type,
      sender_id, sender_username, sender_first_name, sender_last_name,
      direction, message_type, text, media_type, media_file_id,
      reply_to_message_id, forwarded_from_id, forwarded_from_name,
      sent_at, edit_date, is_deleted, deleted_at
    )
    ON CONFLICT(account_id, tg_chat_id, tg_message_id) DO UPDATE SET
      text = EXCLUDED.text,
      edit_date = EXCLUDED.edit_date,
      is_deleted = EXCLUDED.is_deleted,
      deleted_at = EXCLUDED.deleted_at,
      -- W-4/C-2: COALESCE so a richer incoming value wins over null,
      -- but an existing non-null value is never overwritten by null.
      -- Backfill sends null chat_type; live listener sends the correct type.
      chat_name         = COALESCE(EXCLUDED.chat_name, messages.chat_name),
      chat_type         = COALESCE(EXCLUDED.chat_type, messages.chat_type),
      sender_id         = COALESCE(EXCLUDED.sender_id, messages.sender_id),
      sender_username   = COALESCE(EXCLUDED.sender_username, messages.sender_username),
      sender_first_name = COALESCE(EXCLUDED.sender_first_name, messages.sender_first_name),
      sender_last_name  = COALESCE(EXCLUDED.sender_last_name, messages.sender_last_name),
      direction         = COALESCE(EXCLUDED.direction, messages.direction),
      message_type      = COALESCE(EXCLUDED.message_type, messages.message_type),
      media_type        = COALESCE(EXCLUDED.media_type, messages.media_type),
      reply_to_message_id  = COALESCE(EXCLUDED.reply_to_message_id, messages.reply_to_message_id),
      forwarded_from_id    = COALESCE(EXCLUDED.forwarded_from_id, messages.forwarded_from_id),
      forwarded_from_name  = COALESCE(EXCLUDED.forwarded_from_name, messages.forwarded_from_name),
      original_text = CASE
        WHEN EXCLUDED.edit_date IS NOT NULL
        THEN COALESCE(messages.original_text, messages.text)
        ELSE messages.original_text
      END
  `.trim();

  const msgs = messages as Message[];
  const pool = getPool(env);
  let result;
  try {
    result = await pool.query(SQL, [
      accountId,
      msgs.map(m => m.tg_message_id),
      msgs.map(m => m.tg_chat_id),
      msgs.map(m => m.chat_name ?? null),
      msgs.map(m => m.chat_type ?? null),
      msgs.map(m => m.sender_id ?? null),
      msgs.map(m => m.sender_username ?? null),
      msgs.map(m => m.sender_first_name ?? null),
      msgs.map(m => m.sender_last_name ?? null),
      msgs.map(m => m.direction ?? null),
      msgs.map(m => m.message_type ?? null),
      msgs.map(m => m.text ?? null),
      msgs.map(m => m.media_type ?? null),
      msgs.map(m => m.media_file_id ?? null),
      msgs.map(m => m.reply_to_message_id ?? null),
      msgs.map(m => m.forwarded_from_id ?? null),
      msgs.map(m => m.forwarded_from_name ?? null),
      msgs.map(m => m.sent_at),
      msgs.map(m => m.edit_date ?? null),
      msgs.map(m => m.is_deleted ?? 0),
      msgs.map(m => m.deleted_at ?? null),
    ]);
  } catch (err) {
    console.error('[POST /ingest] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  const written = result.rowCount ?? 0;
  const noop = msgs.length - written;
  console.log(`[POST /ingest] written=${written} noop=${noop}`);
  return json({ written, noop });
}

const VALID_SYNC_MODES = ['all', 'blacklist', 'whitelist', 'none'] as const;
const VALID_CHAT_SYNC_VALUES = ['include', 'exclude'] as const;

// Parse epoch seconds or ISO date string → epoch seconds
function parseDate(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  // ISO date/datetime string
  if (raw.includes('-') || raw.includes('T')) {
    const ms = Date.parse(raw);
    return isNaN(ms) ? fallback : Math.floor(ms / 1000);
  }
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

async function handleSearch(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  const p = url.searchParams;
  console.log(`[GET /search] account=${accountId} params=${[...p.keys()].join(',')}`);

  const qRaw = p.get('q');
  // Sanitize tsquery: strip non-word chars from each token first, then enforce min length of 2
  // on the stripped form (W-9: prevents unbounded FTS prefix scans and invalid ":*" tokens
  // that would result from purely-symbolic input like "---" or emojis stripping to empty).
  const qTokens = qRaw !== null
    ? qRaw.trim().split(/\s+/)
        .map(t => t.replace(/[^a-zA-Z0-9\u00C0-\u017F]/g, ''))
        .filter(t => t.length >= 2)
    : null;
  if (qRaw !== null && qRaw.trim() !== '' && qTokens !== null && qTokens.length === 0) {
    return json({ ok: false, error: 'Search query must contain at least one term with 2 or more characters' }, 400);
  }
  const q = qTokens !== null && qTokens.length > 0
    ? qTokens.map(t => t + ':*').join(' & ')
    : null;
  const chatId = p.get('chat_id') ?? null;
  const senderUsername = p.get('sender_username') ?? null;
  const from = parseDate(p.get('from'), 0);
  const to = parseDate(p.get('to'), Math.floor(Date.now() / 1000) + 86400);
  const limit = Math.min(Math.max(parseInt(p.get('limit') ?? '50', 10) || 50, 1), 200);
  // Keyset pagination: (sent_at, id) pair for stable ordering regardless of insert order
  const beforeSentAt = p.get('before_sent_at') ? parseInt(p.get('before_sent_at')!, 10) : null;
  const beforeId = p.get('before_id') ? parseInt(p.get('before_id')!, 10) : null;

  const pool = getPool(env);

  try {
    let dataRows: Array<{ id: number; sent_at: number }>;
    let total: number;

    if (q !== null) {
      // FTS path: search_vector @@ to_tsquery, sort by recency
      const keysetClause = beforeSentAt !== null && beforeId !== null
        ? `AND (m.sent_at < $9 OR (m.sent_at = $9 AND m.id < $10))`
        : ``;

      const DATA_SQL = `
        SELECT m.id, m.tg_message_id, m.tg_chat_id, m.chat_name, m.chat_type,
               m.sender_id, m.sender_username, m.sender_first_name, m.sender_last_name,
               m.direction, m.message_type, m.text, m.media_type,
               m.reply_to_message_id, m.forwarded_from_name, m.sent_at
        FROM messages m
        WHERE m.search_vector @@ to_tsquery('simple', $1)
          AND m.account_id = $2
          AND m.is_deleted = 0
          AND (m.tg_chat_id = $3 OR $4 IS NULL)
          AND (m.sender_username = $5 OR $6 IS NULL)
          AND m.sent_at >= $7
          AND m.sent_at <= $8
          ${keysetClause}
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT $${beforeSentAt !== null && beforeId !== null ? 11 : 9}
      `.trim();

      const COUNT_SQL = `
        SELECT COUNT(*) AS total
        FROM messages m
        WHERE m.search_vector @@ to_tsquery('simple', $1)
          AND m.account_id = $2
          AND m.is_deleted = 0
          AND (m.tg_chat_id = $3 OR $4 IS NULL)
          AND (m.sender_username = $5 OR $6 IS NULL)
          AND m.sent_at >= $7
          AND m.sent_at <= $8
          ${keysetClause}
      `.trim();

      const baseBinds: unknown[] = [q, accountId, chatId, chatId, senderUsername, senderUsername, from, to];
      const keysetBinds: unknown[] = beforeSentAt !== null && beforeId !== null
        ? [beforeSentAt, beforeId]
        : [];

      const [dataResult, countResult] = await Promise.all([
        pool.query(DATA_SQL, [...baseBinds, ...keysetBinds, limit]),
        pool.query<{ total: string }>(COUNT_SQL, [...baseBinds, ...keysetBinds]),
      ]);
      dataRows = dataResult.rows as Array<{ id: number; sent_at: number }>;
      total = parseInt(countResult.rows[0].total, 10);
    } else {
      // B-tree path: no query, sort by recency
      const keysetClause = beforeSentAt !== null && beforeId !== null
        ? `AND (sent_at < $8 OR (sent_at = $8 AND id < $9))`
        : ``;

      const DATA_SQL = `
        SELECT id, tg_message_id, tg_chat_id, chat_name, chat_type,
               sender_id, sender_username, sender_first_name, sender_last_name,
               direction, message_type, text, media_type,
               reply_to_message_id, forwarded_from_name, sent_at
        FROM messages
        WHERE account_id = $1
          AND is_deleted = 0
          AND (tg_chat_id = $2 OR $3 IS NULL)
          AND (sender_username = $4 OR $5 IS NULL)
          AND sent_at >= $6
          AND sent_at <= $7
          ${keysetClause}
        ORDER BY sent_at DESC, id DESC
        LIMIT $${beforeSentAt !== null && beforeId !== null ? 10 : 8}
      `.trim();

      const COUNT_SQL = `
        SELECT COUNT(*) AS total
        FROM messages
        WHERE account_id = $1
          AND is_deleted = 0
          AND (tg_chat_id = $2 OR $3 IS NULL)
          AND (sender_username = $4 OR $5 IS NULL)
          AND sent_at >= $6
          AND sent_at <= $7
          ${keysetClause}
      `.trim();

      const baseBinds: unknown[] = [accountId, chatId, chatId, senderUsername, senderUsername, from, to];
      const keysetBinds: unknown[] = beforeSentAt !== null && beforeId !== null
        ? [beforeSentAt, beforeId]
        : [];

      const [dataResult, countResult] = await Promise.all([
        pool.query(DATA_SQL, [...baseBinds, ...keysetBinds, limit]),
        pool.query<{ total: string }>(COUNT_SQL, [...baseBinds, ...keysetBinds]),
      ]);
      dataRows = dataResult.rows as Array<{ id: number; sent_at: number }>;
      total = parseInt(countResult.rows[0].total, 10);
    }

    const lastRow = dataRows.length === limit ? dataRows[dataRows.length - 1] : null;
    return json({
      results: dataRows,
      total,
      limit,
      next_before_id: lastRow?.id ?? null,
      next_before_sent_at: lastRow?.sent_at ?? null,
    });
  } catch (err) {
    if (q !== null && err instanceof Error && err.message.toLowerCase().includes('tsquery')) {
      return json({ ok: false, error: 'Invalid search query — check for unmatched quotes or special characters' }, 400);
    }
    console.error('[GET /search] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// Contacts ingest
// ---------------------------------------------------------------------------

interface ContactPayload {
  tg_user_id: string;    // always string — 64-bit ID
  phone?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_mutual?: number;    // 1 or 0
  is_bot?: number;       // 1 or 0
}

async function handlePostContacts(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).contacts)
  ) {
    return json({ ok: false, error: 'Body must be { contacts: Contact[] }' }, 400);
  }

  const contacts = (body as { contacts: unknown[] }).contacts;

  if (contacts.length < 1 || contacts.length > 500) {
    return json({ ok: false, error: 'contacts array must have 1–500 items' }, 400);
  }

  console.log(`[POST /contacts] account=${accountId} count=${contacts.length}`);

  // Single UNNEST INSERT — one round trip for up to 500 contacts.
  const SQL = `
    INSERT INTO contacts (account_id, tg_user_id, phone, username, first_name, last_name, is_mutual, is_bot, updated_at)
    SELECT $1, v.tg_user_id, v.phone, v.username, v.first_name, v.last_name, v.is_mutual, v.is_bot,
           EXTRACT(EPOCH FROM NOW())::BIGINT
    FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::smallint[], $8::smallint[])
      AS v(tg_user_id, phone, username, first_name, last_name, is_mutual, is_bot)
    ON CONFLICT(account_id, tg_user_id) DO UPDATE SET
      phone       = COALESCE(EXCLUDED.phone, contacts.phone),
      username    = COALESCE(EXCLUDED.username, contacts.username),
      first_name  = COALESCE(EXCLUDED.first_name, contacts.first_name),
      last_name   = COALESCE(EXCLUDED.last_name, contacts.last_name),
      is_mutual   = COALESCE(EXCLUDED.is_mutual, contacts.is_mutual),
      is_bot      = COALESCE(EXCLUDED.is_bot, contacts.is_bot),
      updated_at  = EXTRACT(EPOCH FROM NOW())::BIGINT
  `.trim();

  const cs = contacts as ContactPayload[];
  const pool = getPool(env);
  let result;
  try {
    result = await pool.query(SQL, [
      accountId,
      cs.map(c => c.tg_user_id),
      cs.map(c => c.phone ?? null),
      cs.map(c => c.username ?? null),
      cs.map(c => c.first_name ?? null),
      cs.map(c => c.last_name ?? null),
      cs.map(c => c.is_mutual ?? null),
      cs.map(c => c.is_bot ?? null),
    ]);
  } catch (err) {
    console.error('[POST /contacts] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  const upserted = result.rowCount ?? 0;
  console.log(`[POST /contacts] upserted=${upserted}`);
  return json({ upserted });
}

async function handleGetContacts(_request: Request, env: Env, accountId: string): Promise<Response> {
  const SQL = `
    SELECT
      c.tg_user_id,
      c.phone,
      c.username,
      c.first_name,
      c.last_name,
      c.is_mutual,
      c.is_bot,
      COUNT(m.id) AS message_count,
      MAX(m.sent_at) AS last_seen
    FROM contacts c
    LEFT JOIN messages m ON m.account_id = c.account_id AND m.sender_id = c.tg_user_id
    WHERE c.account_id = $1
    GROUP BY c.tg_user_id, c.phone, c.username, c.first_name, c.last_name, c.is_mutual, c.is_bot
    ORDER BY last_seen DESC NULLS LAST
  `.trim();

  const pool = getPool(env);
  try {
    const { rows } = await pool.query<{
      tg_user_id: string; phone: string | null; username: string | null;
      first_name: string | null; last_name: string | null;
      is_mutual: number; is_bot: number;
      message_count: string; last_seen: string | null;
    }>(SQL, [accountId]);
    console.log(`[GET /contacts] account=${accountId} count=${rows.length}`);
    return json(rows.map(r => ({
      ...r,
      message_count: parseInt(r.message_count, 10),
      last_seen: r.last_seen !== null ? parseInt(r.last_seen, 10) : null,
    })));
  } catch (err) {
    console.error('[GET /contacts] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleChats(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  const nameFilter = url.searchParams.get('name') ?? null;

  // GROUP BY tg_chat_id only — avoids duplicate rows if chat_name/type changed over time.
  // MAX(chat_name)/MAX(chat_type) picks a deterministic canonical value per chat.
  const SQL = `
    SELECT
      m.tg_chat_id,
      MAX(m.chat_name) AS chat_name,
      MAX(m.chat_type) AS chat_type,
      COUNT(m.id) AS message_count,
      MAX(m.sent_at) AS last_message_at,
      COALESCE(MAX(cc.sync), 'default') AS sync_status
    FROM messages m
    LEFT JOIN chat_config cc ON cc.account_id = m.account_id AND cc.tg_chat_id = m.tg_chat_id
    WHERE m.account_id = $1
      AND (m.chat_name ILIKE $2 OR $3 IS NULL)
    GROUP BY m.tg_chat_id
    ORDER BY last_message_at DESC
  `.trim();

  // W-6: escape LIKE metacharacters so % and _ in nameFilter are treated as literals
  const namePattern = nameFilter !== null
    ? `%${nameFilter.replace(/[%_\\]/g, '\\$&')}%`
    : null;

  const pool = getPool(env);
  try {
    const { rows } = await pool.query<{
      tg_chat_id: string; chat_name: string | null; chat_type: string | null;
      message_count: string; last_message_at: string | null; sync_status: string;
    }>(SQL, [accountId, namePattern, namePattern]);
    console.log(`[GET /chats] account=${accountId} count=${rows.length}`);
    return json(rows.map(r => ({
      ...r,
      message_count: parseInt(r.message_count, 10),
      last_message_at: r.last_message_at !== null ? parseInt(r.last_message_at, 10) : null,
    })));
  } catch (err) {
    console.error('[GET /chats] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleStats(_request: Request, env: Env, accountId: string): Promise<Response> {
  const SQL = `
    SELECT
      COUNT(*) AS total_messages,
      COUNT(DISTINCT tg_chat_id) AS total_chats,
      MIN(sent_at) AS earliest_message_at,
      MAX(sent_at) AS latest_message_at,
      SUM(CASE WHEN is_deleted = 1 THEN 1 ELSE 0 END) AS deleted_count,
      SUM(CASE WHEN edit_date IS NOT NULL THEN 1 ELSE 0 END) AS edited_count,
      SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS received_count
    FROM messages
    WHERE account_id = $1
  `.trim();

  const CONTACT_SQL = `SELECT COUNT(*) AS total_contacts FROM contacts WHERE account_id = $1`;

  const pool = getPool(env);
  try {
    const [msgResult, contactResult] = await Promise.all([
      pool.query<{
        total_messages: string;
        total_chats: string;
        earliest_message_at: number | null;
        latest_message_at: number | null;
        deleted_count: string;
        edited_count: string;
        sent_count: string;
        received_count: string;
      }>(SQL, [accountId]),
      pool.query<{ total_contacts: string }>(CONTACT_SQL, [accountId]),
    ]);
    const stats = msgResult.rows[0];
    const total_contacts = parseInt(contactResult.rows[0].total_contacts, 10);
    return json({
      total_messages: parseInt(stats.total_messages, 10),
      total_chats: parseInt(stats.total_chats, 10),
      earliest_message_at: stats.earliest_message_at,
      latest_message_at: stats.latest_message_at,
      deleted_count: parseInt(stats.deleted_count, 10),
      edited_count: parseInt(stats.edited_count, 10),
      sent_count: parseInt(stats.sent_count, 10),
      received_count: parseInt(stats.received_count, 10),
      total_contacts,
    });
  } catch (err) {
    console.error('[GET /stats] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleGetConfig(_request: Request, env: Env): Promise<Response> {
  const pool = getPool(env);
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM global_config WHERE key = 'sync_mode'`,
      [],
    );
    return json({ sync_mode: rows[0]?.value ?? 'all' });
  } catch (err) {
    console.error('[GET /config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handlePostConfig(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const syncMode = (body as Record<string, unknown>).sync_mode;
  if (!VALID_SYNC_MODES.includes(syncMode as typeof VALID_SYNC_MODES[number])) {
    return json({ ok: false, error: `sync_mode must be one of: ${VALID_SYNC_MODES.join(', ')}` }, 400);
  }

  const pool = getPool(env);
  try {
    await pool.query(
      `INSERT INTO global_config (key, value) VALUES ('sync_mode', $1) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      [syncMode],
    );
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleGetChatsConfig(_request: Request, env: Env, accountId: string): Promise<Response> {
  const pool = getPool(env);
  try {
    const { rows } = await pool.query(
      `SELECT tg_chat_id, chat_name, sync, updated_at FROM chat_config WHERE account_id = $1 ORDER BY updated_at DESC`,
      [accountId],
    );
    return json(rows);
  } catch (err) {
    console.error('[GET /chats/config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handlePostChatsConfig(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const b = body as Record<string, unknown>;
  if (!b.tg_chat_id || typeof b.tg_chat_id !== 'string') {
    return json({ ok: false, error: 'tg_chat_id is required' }, 400);
  }
  if (!VALID_CHAT_SYNC_VALUES.includes(b.sync as typeof VALID_CHAT_SYNC_VALUES[number])) {
    return json({ ok: false, error: `sync must be 'include' or 'exclude'` }, 400);
  }

  const pool = getPool(env);
  try {
    await pool.query(
      `INSERT INTO chat_config (account_id, tg_chat_id, chat_name, sync, updated_at)
       VALUES ($1, $2, $3, $4, EXTRACT(EPOCH FROM NOW())::BIGINT)
       ON CONFLICT(account_id, tg_chat_id) DO UPDATE SET
         chat_name = EXCLUDED.chat_name,
         sync = EXCLUDED.sync,
         updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
      [accountId, b.tg_chat_id, b.chat_name ?? null, b.sync],
    );
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /chats/config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleDeleteChatsConfig(tgChatId: string, env: Env, accountId: string): Promise<Response> {
  const pool = getPool(env);
  try {
    await pool.query(
      `DELETE FROM chat_config WHERE account_id = $1 AND tg_chat_id = $2`,
      [accountId, tgChatId],
    );
    return json({ ok: true });
  } catch (err) {
    console.error('[DELETE /chats/config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// Backfill handlers
// ---------------------------------------------------------------------------

interface BackfillSeedDialog {
  tg_chat_id: string;
  chat_name: string | null;
  total_messages: number | null;
}

async function handleDeleted(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages)) {
    return json({ ok: false, error: 'Body must be { messages: [{tg_chat_id, tg_message_id}][] }' }, 400);
  }

  const rawMessages = b.messages as Array<unknown>;
  if (rawMessages.length < 1 || rawMessages.length > 500) {
    return json({ ok: false, error: 'messages array must have 1–500 items' }, 400);
  }

  // W-8: validate each item individually
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i] as Record<string, unknown>;
    if (typeof m.tg_chat_id !== 'string' || typeof m.tg_message_id !== 'string') {
      return json({
        ok: false,
        error: `messages[${i}] must have tg_chat_id (string) and tg_message_id (string)`,
      }, 400);
    }
  }
  const messages = rawMessages as Array<{ tg_chat_id: string; tg_message_id: string }>;

  console.log(`[POST /deleted] account=${accountId} count=${messages.length}`);

  // Single UPDATE with UNNEST — one round trip for up to 500 deletions.
  const SQL = `
    UPDATE messages
    SET is_deleted = 1, deleted_at = EXTRACT(EPOCH FROM NOW())::BIGINT
    WHERE account_id = $1
      AND (tg_chat_id, tg_message_id) IN (SELECT * FROM UNNEST($2::text[], $3::text[]))
  `.trim();

  const pool = getPool(env);
  let result;
  try {
    result = await pool.query(SQL, [
      accountId,
      messages.map(m => m.tg_chat_id),
      messages.map(m => m.tg_message_id),
    ]);
  } catch (err) {
    console.error('[POST /deleted] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  const marked = result.rowCount ?? 0;
  console.log(`[POST /deleted] marked=${marked}`);
  return json({ marked });
}

async function handleBackfillSeed(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.dialogs)) {
    return json({ ok: false, error: 'Body must be { dialogs: Dialog[] }' }, 400);
  }

  const dialogs = b.dialogs as BackfillSeedDialog[];
  if (dialogs.length < 1 || dialogs.length > 500) {
    return json({ ok: false, error: 'dialogs array must have 1–500 items' }, 400);
  }

  console.log(`[POST /backfill/seed] account=${accountId} count=${dialogs.length}`);

  // Single UNNEST INSERT — one round trip for up to 500 dialogs.
  const SQL = `
    INSERT INTO backfill_state (account_id, tg_chat_id, chat_name, total_messages, status)
    SELECT $1, v.tg_chat_id, v.chat_name, v.total_messages, 'pending'
    FROM UNNEST($2::text[], $3::text[], $4::bigint[]) AS v(tg_chat_id, chat_name, total_messages)
    ON CONFLICT DO NOTHING
  `.trim();

  const pool = getPool(env);
  let result;
  try {
    result = await pool.query(SQL, [
      accountId,
      dialogs.map(d => d.tg_chat_id),
      dialogs.map(d => d.chat_name ?? null),
      dialogs.map(d => d.total_messages ?? null),
    ]);
  } catch (err) {
    console.error('[POST /backfill/seed] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  const seeded = result.rowCount ?? 0;
  console.log(`[POST /backfill/seed] seeded=${seeded}`);
  return json({ seeded });
}

async function handleBackfillPending(_request: Request, env: Env, accountId: string): Promise<Response> {
  const SQL = `
    SELECT tg_chat_id, chat_name, total_messages, fetched_messages, oldest_message_id, status
    FROM backfill_state
    WHERE account_id = $1 AND status IN ('pending', 'in_progress')
    ORDER BY tg_chat_id
  `.trim();

  const pool = getPool(env);
  try {
    const { rows } = await pool.query(SQL, [accountId]);
    console.log(`[GET /backfill/pending] account=${accountId} count=${rows.length}`);
    return json(rows);
  } catch (err) {
    console.error('[GET /backfill/pending] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleBackfillProgress(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  if (!b.tg_chat_id || typeof b.tg_chat_id !== 'string') {
    return json({ ok: false, error: 'tg_chat_id is required' }, 400);
  }

  const VALID_BACKFILL_STATUSES = ['in_progress', 'complete', 'failed'] as const;
  if (b.status !== undefined && !VALID_BACKFILL_STATUSES.includes(b.status as typeof VALID_BACKFILL_STATUSES[number])) {
    return json({ ok: false, error: `status must be one of: ${VALID_BACKFILL_STATUSES.join(', ')}` }, 400);
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  let p = 0;
  const next = () => `$${++p}`;

  // W-7: validate each field type before accepting
  if (b.status !== undefined) { sets.push(`status = ${next()}`); binds.push(b.status as string); }
  if (b.oldest_message_id !== undefined) {
    if (typeof b.oldest_message_id !== 'number' || !Number.isInteger(b.oldest_message_id)) {
      return json({ ok: false, error: 'oldest_message_id must be an integer' }, 400);
    }
    sets.push(`oldest_message_id = ${next()}`); binds.push(b.oldest_message_id);
  }
  if (b.fetched_messages !== undefined) {
    if (typeof b.fetched_messages !== 'number' || !Number.isInteger(b.fetched_messages)) {
      return json({ ok: false, error: 'fetched_messages must be an integer' }, 400);
    }
    sets.push(`fetched_messages = ${next()}`); binds.push(b.fetched_messages);
  }
  if (b.last_error !== undefined) {
    if (typeof b.last_error !== 'string') {
      return json({ ok: false, error: 'last_error must be a string' }, 400);
    }
    sets.push(`last_error = ${next()}`); binds.push((b.last_error as string).slice(0, 1000));
  }
  if (b.status === 'in_progress') {
    sets.push(`started_at = COALESCE(started_at, ${next()})`);
    binds.push(Math.floor(Date.now() / 1000));
  }
  if (b.status === 'complete' || b.status === 'failed') {
    sets.push(`completed_at = ${next()}`);
    binds.push(Math.floor(Date.now() / 1000));
  }

  if (sets.length === 0) {
    return json({ ok: false, error: 'nothing to update' }, 400);
  }

  binds.push(accountId);
  binds.push(b.tg_chat_id as string);

  const SQL = `UPDATE backfill_state SET ${sets.join(', ')} WHERE account_id = ${next()} AND tg_chat_id = ${next()}`;

  console.log(`[POST /backfill/progress] account=${accountId} sets=${sets.length}`);

  const pool = getPool(env);
  try {
    await pool.query(SQL, binds);
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /backfill/progress] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — Streamable HTTP transport, spec 2024-11-05
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Token, X-Account-ID',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function mcpJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function mcpError(id: unknown, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const MCP_TOOL_DEFINITIONS = [
  {
    name: 'search',
    description: 'Full-text search across the complete Telegram message archive (100k+ messages going back to 2020). Results are ranked by relevance then recency. Use this for ANY question about past conversations, finding specific messages, amounts, names, or topics. Always use from/to when the user mentions a time period. For sender-specific searches, use sender_username. Paginate with next_before_id + next_before_sent_at from the previous response.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords. Multiple words are ANDed — all must appear in the message. Use words likely to appear verbatim in the text.' },
        chat_id: { type: 'string', description: 'Optional. Filter to one chat (get IDs from the chats tool). Leave empty to search all chats.' },
        sender_username: { type: 'string', description: 'Optional. Filter to messages from a specific sender by username (without @). Use contacts tool to look up usernames.' },
        from: { type: 'string', description: 'Optional. Start of date range. ISO 8601 (e.g. "2024-01-01") or Unix epoch seconds. Include when the user mentions a time period.' },
        to: { type: 'string', description: 'Optional. End of date range. ISO 8601 or Unix epoch seconds. Defaults to tomorrow.' },
        limit: { type: 'number', description: 'Results per page (1–50, default 20).' },
        before_id: { type: 'number', description: 'Pagination: pass next_before_id from the previous response. Must be paired with before_sent_at.' },
        before_sent_at: { type: 'number', description: 'Pagination: pass next_before_sent_at from the previous response. Must be paired with before_id.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'chats',
    description: 'List all Telegram chats (groups, channels, DMs) with message counts and last activity. Use to discover chat IDs before calling history, or to find which chat a conversation happened in. Optionally filter by chat name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional. Filter chats by name (case-insensitive partial match). Example: "DevOps" matches "DevOps Team" and "devops-general".' },
      },
    },
  },
  {
    name: 'history',
    description: 'Get messages from one chat in chronological order (oldest first). Use after chats gives you a chat_id. For finding specific content within a chat, prefer search with chat_id filter instead. Paginate forward by passing next_after_id + next_after_sent_at from the previous response.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID (string, may be negative for groups/channels). Get from the chats tool.' },
        limit: { type: 'number', description: 'Messages per page (default 20, max 50).' },
        after_id: { type: 'number', description: 'Pagination: pass next_after_id from the previous response to get the next (newer) page.' },
        after_sent_at: { type: 'number', description: 'Pagination: pass next_after_sent_at from the previous response. Must be paired with after_id.' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'contacts',
    description: 'List Telegram contacts with username, name, and message count. Use to find someone\'s username before searching their messages, or to see who you talk to most. Note: contacts are people saved in your phone — group members without saved contact may not appear here.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional. Filter by name or username (case-insensitive partial match).' },
      },
    },
  },
  {
    name: 'recent',
    description: 'Get the most recent messages across all chats, sorted newest-first. Use only for "what\'s new" or "latest activity" queries. For any historical lookup, use search instead.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of messages (default 20, max 50).' },
      },
    },
  },
  {
    name: 'stats',
    description: 'Get archive statistics: total message count, date range, number of chats and contacts, sent vs received breakdown. Use this first when the user asks about the archive, or to discover what date range is available before searching.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const TEXT_SNIPPET_LEN = 500;
function truncateText(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.text === 'string' && row.text.length > TEXT_SNIPPET_LEN) {
    return { ...row, text: row.text.slice(0, TEXT_SNIPPET_LEN) + '…' };
  }
  return row;
}

async function dispatchMcpTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  accountId: string,
): Promise<unknown> {
  const baseUrl = 'https://internal';

  if (name === 'search') {
    const params = new URLSearchParams();
    if (typeof args.query === 'string') params.set('q', args.query);
    if (typeof args.chat_id === 'string') params.set('chat_id', args.chat_id);
    if (typeof args.sender_username === 'string') params.set('sender_username', args.sender_username);
    if (args.from !== undefined) params.set('from', String(args.from));
    if (args.to !== undefined) params.set('to', String(args.to));
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50);
    params.set('limit', String(limit));
    if (typeof args.before_id === 'number') params.set('before_id', String(args.before_id));
    if (typeof args.before_sent_at === 'number') params.set('before_sent_at', String(args.before_sent_at));
    const req = new Request(`${baseUrl}/search?${params.toString()}`);
    const res = await handleSearch(req, env, accountId);
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    if (Array.isArray(data.results)) {
      data.results = data.results.map(truncateText);
    }
    return data;
  }

  if (name === 'chats') {
    const params = new URLSearchParams();
    if (typeof args.name === 'string') params.set('name', args.name);
    const req = new Request(`${baseUrl}/chats?${params.toString()}`);
    const res = await handleChats(req, env, accountId);
    return await res.json();
  }

  if (name === 'history') {
    // W-11: use ASC ordering with after_ keyset cursors so pages advance forward in time.
    if (typeof args.chat_id !== 'string') throw new Error('chat_id is required');
    const chatId = args.chat_id;
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50);
    const afterSentAt = typeof args.after_sent_at === 'number' ? args.after_sent_at : null;
    const afterId = typeof args.after_id === 'number' ? args.after_id : null;

    const keysetClause = afterSentAt !== null && afterId !== null
      ? `AND (sent_at > $3 OR (sent_at = $3 AND id > $4))`
      : ``;

    const SQL = `
      SELECT id, tg_message_id, tg_chat_id, chat_name, chat_type,
             sender_id, sender_username, sender_first_name, sender_last_name,
             direction, message_type, text, media_type,
             reply_to_message_id, forwarded_from_name, sent_at
      FROM messages
      WHERE account_id = $1
        AND tg_chat_id = $2
        AND is_deleted = 0
        ${keysetClause}
      ORDER BY sent_at ASC, id ASC
      LIMIT $${afterSentAt !== null && afterId !== null ? 5 : 3}
    `.trim();

    const pool = getPool(env);
    const binds: unknown[] = afterSentAt !== null && afterId !== null
      ? [accountId, chatId, afterSentAt, afterId, limit]
      : [accountId, chatId, limit];

    const { rows } = await pool.query(SQL, binds);
    const typedRows = rows as Array<Record<string, unknown> & { id: number; sent_at: number }>;
    const lastRow = typedRows.length === limit ? typedRows[typedRows.length - 1] : null;

    return {
      results: typedRows.map(truncateText),
      limit,
      next_after_id: lastRow?.id ?? null,
      next_after_sent_at: lastRow?.sent_at ?? null,
    };
  }

  if (name === 'contacts') {
    const search = typeof args.search === 'string' && args.search.trim() !== ''
      ? `%${args.search.trim()}%`
      : null;
    const SQL = `
      SELECT
        c.tg_user_id,
        c.phone,
        c.username,
        c.first_name,
        c.last_name,
        c.is_mutual,
        c.is_bot,
        COUNT(m.id) AS message_count,
        MAX(m.sent_at) AS last_seen
      FROM contacts c
      LEFT JOIN messages m ON m.account_id = c.account_id AND m.sender_id = c.tg_user_id
      WHERE c.account_id = $1
        AND ($2::text IS NULL OR c.first_name ILIKE $2 OR c.last_name ILIKE $2 OR c.username ILIKE $2)
      GROUP BY c.tg_user_id, c.phone, c.username, c.first_name, c.last_name, c.is_mutual, c.is_bot
      ORDER BY last_seen DESC NULLS LAST
    `.trim();
    const { rows } = await getPool(env).query<{
      tg_user_id: string; phone: string | null; username: string | null;
      first_name: string | null; last_name: string | null;
      is_mutual: number; is_bot: number;
      message_count: string; last_seen: string | null;
    }>(SQL, [accountId, search]);
    return rows.map(r => ({
      ...r,
      message_count: parseInt(r.message_count, 10),
      last_seen: r.last_seen !== null ? parseInt(r.last_seen, 10) : null,
    }));
  }

  if (name === 'recent') {
    const params = new URLSearchParams();
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50);
    params.set('limit', String(limit));
    const req = new Request(`${baseUrl}/search?${params.toString()}`);
    const res = await handleSearch(req, env, accountId);
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    if (Array.isArray(data.results)) {
      data.results = data.results.map(truncateText);
    }
    return data;
  }

  if (name === 'stats') {
    const req = new Request(`${baseUrl}/stats`);
    const res = await handleStats(req, env, accountId);
    return await res.json();
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcpMessage(
  msg: Record<string, unknown>,
  env: Env,
  accountId: string,
): Promise<object | null> { // null = notification — caller must not send a response
  const { jsonrpc, id, method, params } = msg as {
    jsonrpc: string;
    id: unknown;
    method: string;
    params?: Record<string, unknown>;
  };

  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return mcpError(id ?? null, -32600, 'Invalid Request');
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tg-reader', version: '1.0.0' },
        instructions: `You have access to a complete Telegram message archive. Use the "stats" tool first if you need to know the date range or message count.

TOOL SELECTION GUIDE:
- "search" — primary tool. Use for ANY question about past conversations, specific content, people, amounts, topics, or events. Results ranked by relevance then recency. Always set from/to when user mentions a time period. Use sender_username to filter by person.
- "stats" — archive overview: total messages, date range, chats, contacts. Use when user asks about the archive size, or before searching to confirm data exists.
- "chats" — lists all chats with message counts. Filter by name param. Use to get chat_id before calling history, or to find which chat something happened in.
- "history" — reads one chat chronologically. Use only for browsing a thread. For finding content, use search with chat_id filter.
- "contacts" — find people by name/username. Use to look up sender_username before filtering search.
- "recent" — latest messages across all chats. Use only for "what's new" queries.

PAGINATION: search returns next_before_id + next_before_sent_at (pass to next call to go to older results). history returns next_after_id + next_after_sent_at (pass to next call to go to newer/later messages).

IMPORTANT: The archive is complete and historical. Never tell the user data is unavailable — search with broader terms or a wider date range. If a search returns nothing, try synonyms or remove filters before giving up.`,
      },
    };
  }

  if (method === 'notifications/initialized') {
    // W-10: JSON-RPC 2.0 spec — servers MUST NOT send a response to notifications.
    return null;
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOL_DEFINITIONS },
    };
  }

  if (method === 'tools/call') {
    const toolName = (params as Record<string, unknown>)?.name;
    const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;

    if (typeof toolName !== 'string') {
      return mcpError(id, -32602, 'Invalid params: name is required');
    }

    try {
      const data = await dispatchMcpTool(toolName, toolArgs, env, accountId);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      return mcpError(id, -32603, message);
    }
  }

  return mcpError(id ?? null, -32601, 'Method not found');
}

async function handleMcp(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mcpJson(mcpError(null, -32700, 'Parse error'), 400);
  }

  // Batch array
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return mcpJson(mcpError(null, -32600, 'Invalid Request: empty batch'), 400);
    }
    const all = await Promise.all(
      body.map((msg) => handleMcpMessage(msg as Record<string, unknown>, env, accountId)),
    );
    // W-10: omit null entries (notifications) from batch response per JSON-RPC 2.0
    const responses = all.filter((r): r is object => r !== null);
    if (responses.length === 0) return new Response(null, { status: 204 });
    return mcpJson(responses);
  }

  // Single message
  if (typeof body === 'object' && body !== null) {
    const response = await handleMcpMessage(body as Record<string, unknown>, env, accountId);
    // W-10: notification — no response body
    if (response === null) return new Response(null, { status: 204, headers: CORS_HEADERS });
    return mcpJson(response);
  }

  return mcpJson(mcpError(null, -32600, 'Invalid Request'), 400);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === 'POST' && pathname === '/ingest') {
    return handleIngest(request, env, accountId);
  }

  if (method === 'GET' && pathname === '/search') {
    return handleSearch(request, env, accountId);
  }

  if (method === 'GET' && pathname === '/stats') {
    return handleStats(request, env, accountId);
  }

  if (method === 'GET' && pathname === '/contacts') {
    return handleGetContacts(request, env, accountId);
  }

  if (method === 'POST' && pathname === '/contacts') {
    return handlePostContacts(request, env, accountId);
  }

  if (method === 'GET' && pathname === '/chats') {
    return handleChats(request, env, accountId);
  }

  if (method === 'GET' && pathname === '/config') {
    return handleGetConfig(request, env);
  }

  if (method === 'POST' && pathname === '/config') {
    return handlePostConfig(request, env);
  }

  if (method === 'GET' && pathname === '/chats/config') {
    return handleGetChatsConfig(request, env, accountId);
  }

  if (method === 'POST' && pathname === '/chats/config') {
    return handlePostChatsConfig(request, env, accountId);
  }

  // DELETE /chats/config/:tg_chat_id
  const deleteMatch = pathname.match(/^\/chats\/config\/(.+)$/);
  if (method === 'DELETE' && deleteMatch) {
    const tgChatId = decodeURIComponent(deleteMatch[1]);
    return handleDeleteChatsConfig(tgChatId, env, accountId);
  }

  if (method === 'POST' && pathname === '/deleted') {
    return handleDeleted(request, env, accountId);
  }

  if (method === 'POST' && pathname === '/backfill/seed') {
    return handleBackfillSeed(request, env, accountId);
  }

  if (method === 'GET' && pathname === '/backfill/pending') {
    return handleBackfillPending(request, env, accountId);
  }

  if (method === 'POST' && pathname === '/backfill/progress') {
    return handleBackfillProgress(request, env, accountId);
  }

  if (method === 'POST' && pathname === '/mcp') {
    return handleMcp(request, env, accountId);
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

// W-2: account ID must be 'primary' or a numeric Telegram user ID (up to 20 digits).
function isValidAccountId(id: string): boolean {
  return id === 'primary' || /^\d{1,20}$/.test(id);
}

async function fetch(request: Request, env: Env): Promise<Response> {
  // OPTIONS preflight must bypass auth — claude.ai makes cross-origin requests
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const isMcp = url.pathname === '/mcp';

  // For /mcp: the claude.ai connector dialog only supports a URL — no custom headers.
  // Fall back to ?token= and ?account_id= query params so connector URLs keep working.
  const tokenOverride = isMcp ? url.searchParams.get('token') : null;
  const accountIdOverride = isMcp ? url.searchParams.get('account_id') : null;

  const authError = await authenticate(request, env, tokenOverride);
  if (authError) {
    // W-15: add CORS headers to auth errors on /mcp so browser callers see a readable 401
    if (isMcp) {
      return new Response(authError.body, {
        status: authError.status,
        headers: { ...Object.fromEntries(authError.headers.entries()), ...CORS_HEADERS },
      });
    }
    return authError;
  }

  // W-2: account ID from header; query-string fallback for /mcp connector URLs only
  const accountId = request.headers.get('X-Account-ID') ?? accountIdOverride ?? 'primary';
  if (!isValidAccountId(accountId)) {
    return json({ ok: false, error: 'Invalid X-Account-ID: must be "primary" or a numeric Telegram user ID' }, 400);
  }

  return route(request, env, accountId);
}

// ---------------------------------------------------------------------------
// Scheduled handler (cron backup)
// ---------------------------------------------------------------------------

async function* streamMessages(pool: Pool): AsyncGenerator<string> {
  // W-12: use keyset pagination (WHERE id > lastId) instead of OFFSET.
  const batchSize = 1000;
  let lastId = 0;
  while (true) {
    const { rows } = await pool.query(
      `SELECT id, account_id, tg_message_id, tg_chat_id, chat_name, chat_type,
              sender_id, sender_username, sender_first_name, sender_last_name,
              direction, message_type, text, media_type, media_file_id,
              reply_to_message_id, forwarded_from_id, forwarded_from_name,
              sent_at, edit_date, original_text, is_deleted, deleted_at, indexed_at
       FROM messages WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      yield JSON.stringify(row) + '\n';
    }
    lastId = (rows[rows.length - 1] as { id: number }).id;
    if (rows.length < batchSize) break;
  }
}

async function runBackup(env: Env): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `backup-${date}.ndjson`;
  const pool = getPool(env);

  try {
    const encoder = new TextEncoder();
    let rowCount = 0;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const line of streamMessages(pool)) {
            controller.enqueue(encoder.encode(line));
            rowCount++;
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    await env.BACKUP_BUCKET.put(key, stream, {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
    console.log(`[backup] uploaded key=${key} rows=${rowCount}`);
  } catch (err) {
    console.error('[backup] failed', err);
  }
}

async function runStorageCheck(env: Env): Promise<void> {
  const pool = getPool(env);
  try {
    const { rows } = await pool.query<{ total_messages: string; text_bytes: string }>(
      `SELECT COUNT(*) AS total_messages, SUM(LENGTH(COALESCE(text, ''))) AS text_bytes FROM messages`,
      [],
    );

    const row = rows[0];
    if (!row) return;

    const totalMessages = parseInt(row.total_messages, 10);
    const textBytes = parseInt(row.text_bytes ?? '0', 10);

    // Conservative estimate: 1 KB per row overhead
    const estimatedBytes = totalMessages * 1024;
    const estimatedGB = (estimatedBytes / 1_073_741_824).toFixed(2);
    const textGB = (textBytes / 1_073_741_824).toFixed(2);

    const level = estimatedBytes > 50 * 1_073_741_824 ? 'WARNING' : 'INFO';
    console.log(
      `[storage-check] ${level} total_messages=${totalMessages} text_gb=${textGB} estimated_gb=${estimatedGB}`,
    );
    if (level === 'WARNING') {
      console.warn('[storage-check] large dataset — consider archiving old messages');
    }
  } catch (err) {
    console.error('[storage-check] failed', err);
  }
}

// W-13: match both cron expressions explicitly to avoid accidental backup runs
const CRON_DAILY_BACKUP        = '0 3 * * *';   // matches wrangler.toml
const CRON_MONTHLY_STORAGE_CHK = '0 4 1 * *';   // matches wrangler.toml

async function scheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (event.cron === CRON_DAILY_BACKUP) {
    await runBackup(env);
  } else if (event.cron === CRON_MONTHLY_STORAGE_CHK) {
    await runStorageCheck(env);
  } else {
    console.error(`[scheduled] unknown cron expression: ${event.cron} — no action taken`);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default { fetch, scheduled };
