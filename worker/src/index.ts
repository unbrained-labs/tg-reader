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

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authenticate(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const token = request.headers.get('X-Ingest-Token') ?? url.searchParams.get('token');
  if (!token || token !== env.INGEST_TOKEN) {
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

  // Validate required fields on each message
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown>;
    if (typeof m.tg_message_id !== 'number' || typeof m.tg_chat_id !== 'string' || typeof m.sent_at !== 'number') {
      return json({ ok: false, error: `messages[${i}] missing required fields: tg_message_id (number), tg_chat_id (string), sent_at (number)` }, 400);
    }
  }

  console.log(`[POST /ingest] account=${accountId} count=${messages.length}`);

  // Build one prepared statement per message
  const SQL = `
    INSERT INTO messages (
      account_id, tg_message_id, tg_chat_id, chat_name, chat_type,
      sender_id, sender_username, sender_first_name, sender_last_name,
      direction, message_type, text, media_type, media_file_id,
      reply_to_message_id, forwarded_from_id, forwarded_from_name,
      sent_at, edit_date, is_deleted, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, tg_chat_id, tg_message_id) DO UPDATE SET
      text = excluded.text,
      edit_date = excluded.edit_date,
      is_deleted = excluded.is_deleted,
      deleted_at = excluded.deleted_at,
      chat_name = excluded.chat_name,
      chat_type = excluded.chat_type,
      original_text = CASE
        WHEN excluded.edit_date IS NOT NULL
        THEN COALESCE(messages.original_text, messages.text)
        ELSE messages.original_text
      END
  `.trim();

  const stmts = (messages as Message[]).map((msg) =>
    env.DB.prepare(SQL).bind(
      accountId,
      msg.tg_message_id,
      msg.tg_chat_id,
      msg.chat_name ?? null,
      msg.chat_type ?? null,
      msg.sender_id ?? null,
      msg.sender_username ?? null,
      msg.sender_first_name ?? null,
      msg.sender_last_name ?? null,
      msg.direction ?? null,
      msg.message_type ?? null,
      msg.text ?? null,
      msg.media_type ?? null,
      msg.media_file_id ?? null,
      msg.reply_to_message_id ?? null,
      msg.forwarded_from_id ?? null,
      msg.forwarded_from_name ?? null,
      msg.sent_at,
      msg.edit_date ?? null,
      msg.is_deleted ?? 0,
      msg.deleted_at ?? null,
    ),
  );

  // Execute batch
  let results: D1Result[];
  try {
    results = await env.DB.batch(stmts);
  } catch (err) {
    console.error('[POST /ingest] DB batch error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  // Count inserted vs skipped by rows_written
  let inserted = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.meta.rows_written > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }

  console.log(`[POST /ingest] inserted=${inserted} skipped=${skipped}`);
  return json({ inserted, skipped });
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
  // Sanitize FTS5 query: quote each token individually to prevent operator injection
  // while preserving multi-word AND semantics ("hello" "world" = hello AND world).
  const q = qRaw !== null
    ? qRaw.trim().split(/\s+/).filter(Boolean).map(t => '"' + t.replace(/"/g, '""') + '"*').join(' ') || null
    : null;
  const chatId = p.get('chat_id') ?? null;
  const senderUsername = p.get('sender_username') ?? null;
  const from = parseDate(p.get('from'), 0);
  const to = parseDate(p.get('to'), Math.floor(Date.now() / 1000) + 86400);
  const limit = Math.min(Math.max(parseInt(p.get('limit') ?? '50', 10) || 50, 1), 200);
  // Keyset pagination: (sent_at, id) pair for stable ordering regardless of insert order
  const beforeSentAt = p.get('before_sent_at') ? parseInt(p.get('before_sent_at')!, 10) : null;
  const beforeId = p.get('before_id') ? parseInt(p.get('before_id')!, 10) : null;

  // Build keyset WHERE clause — handles both first-page (no cursor) and subsequent pages
  // Compound cursor: (sent_at < X) OR (sent_at = X AND id < Y)
  const keysetClause = beforeSentAt !== null && beforeId !== null
    ? `AND (m.sent_at < ? OR (m.sent_at = ? AND m.id < ?))`
    : ``;
  const keysetBinds = beforeSentAt !== null && beforeId !== null
    ? [beforeSentAt, beforeSentAt, beforeId]
    : [];

  // Plain messages table version (no FTS5)
  const plainKeysetClause = beforeSentAt !== null && beforeId !== null
    ? `AND (sent_at < ? OR (sent_at = ? AND id < ?))`
    : ``;

  try {
    let dataStmt: D1PreparedStatement;
    let countStmt: D1PreparedStatement;

    if (q !== null) {
      // FTS5 path: sort by relevance rank first, then recency as tiebreaker
      const SQL = `
        SELECT m.id, m.tg_message_id, m.tg_chat_id, m.chat_name, m.chat_type,
               m.sender_id, m.sender_username, m.sender_first_name, m.sender_last_name,
               m.direction, m.message_type, m.text, m.media_type,
               m.reply_to_message_id, m.forwarded_from_name, m.sent_at
        FROM messages m
        JOIN messages_fts ON messages_fts.rowid = m.id
        WHERE messages_fts MATCH ?
          AND m.account_id = ?
          AND m.is_deleted = 0
          AND (m.tg_chat_id = ? OR ? IS NULL)
          AND (m.sender_username = ? OR ? IS NULL)
          AND m.sent_at >= ?
          AND m.sent_at <= ?
          ${keysetClause}
        ORDER BY messages_fts.rank, m.sent_at DESC, m.id DESC
        LIMIT ?
      `.trim();
      const COUNT_SQL = `
        SELECT COUNT(*) AS total
        FROM messages m
        JOIN messages_fts ON messages_fts.rowid = m.id
        WHERE messages_fts MATCH ?
          AND m.account_id = ?
          AND m.is_deleted = 0
          AND (m.tg_chat_id = ? OR ? IS NULL)
          AND (m.sender_username = ? OR ? IS NULL)
          AND m.sent_at >= ?
          AND m.sent_at <= ?
      `.trim();
      dataStmt = env.DB.prepare(SQL).bind(q, accountId, chatId, chatId, senderUsername, senderUsername, from, to, ...keysetBinds, limit);
      countStmt = env.DB.prepare(COUNT_SQL).bind(q, accountId, chatId, chatId, senderUsername, senderUsername, from, to);
    } else {
      // B-tree path: no query, sort by recency
      const SQL = `
        SELECT id, tg_message_id, tg_chat_id, chat_name, chat_type,
               sender_id, sender_username, sender_first_name, sender_last_name,
               direction, message_type, text, media_type,
               reply_to_message_id, forwarded_from_name, sent_at
        FROM messages
        WHERE account_id = ?
          AND is_deleted = 0
          AND (tg_chat_id = ? OR ? IS NULL)
          AND (sender_username = ? OR ? IS NULL)
          AND sent_at >= ?
          AND sent_at <= ?
          ${plainKeysetClause}
        ORDER BY sent_at DESC, id DESC
        LIMIT ?
      `.trim();
      const COUNT_SQL = `
        SELECT COUNT(*) AS total
        FROM messages
        WHERE account_id = ?
          AND is_deleted = 0
          AND (tg_chat_id = ? OR ? IS NULL)
          AND (sender_username = ? OR ? IS NULL)
          AND sent_at >= ?
          AND sent_at <= ?
      `.trim();
      dataStmt = env.DB.prepare(SQL).bind(accountId, chatId, chatId, senderUsername, senderUsername, from, to, ...keysetBinds, limit);
      countStmt = env.DB.prepare(COUNT_SQL).bind(accountId, chatId, chatId, senderUsername, senderUsername, from, to);
    }

    const [dataResult, countResult] = await env.DB.batch([dataStmt, countStmt]);
    const total = (countResult.results[0] as { total: number }).total;
    const rows = dataResult.results as Array<{ id: number; sent_at: number }>;
    const lastRow = rows.length === limit ? rows[rows.length - 1] : null;
    return json({
      results: rows,
      total,
      limit,
      // Compound cursor — pass both to next request as before_sent_at + before_id
      next_before_id: lastRow?.id ?? null,
      next_before_sent_at: lastRow?.sent_at ?? null,
    });
  } catch (err) {
    if (q !== null && err instanceof Error && err.message.toLowerCase().includes('fts5')) {
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

  const SQL = `
    INSERT INTO contacts (account_id, tg_user_id, phone, username, first_name, last_name, is_mutual, is_bot, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(account_id, tg_user_id) DO UPDATE SET
      phone       = COALESCE(excluded.phone, contacts.phone),
      username    = COALESCE(excluded.username, contacts.username),
      first_name  = COALESCE(excluded.first_name, contacts.first_name),
      last_name   = COALESCE(excluded.last_name, contacts.last_name),
      is_mutual   = COALESCE(excluded.is_mutual, contacts.is_mutual),
      is_bot      = COALESCE(excluded.is_bot, contacts.is_bot),
      updated_at  = unixepoch()
  `.trim();

  const stmts = (contacts as ContactPayload[]).map((c) =>
    env.DB.prepare(SQL).bind(
      accountId,
      c.tg_user_id,
      c.phone ?? null,
      c.username ?? null,
      c.first_name ?? null,
      c.last_name ?? null,
      c.is_mutual ?? null,
      c.is_bot ?? null,
    ),
  );

  let results: D1Result[];
  try {
    results = await env.DB.batch(stmts);
  } catch (err) {
    console.error('[POST /contacts] DB batch error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  let upserted = 0;
  for (const result of results) {
    if (result.meta.rows_written > 0) {
      upserted++;
    }
  }

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
    WHERE c.account_id = ?
    GROUP BY c.tg_user_id
    ORDER BY last_seen DESC NULLS LAST
  `.trim();

  let results: unknown[];
  try {
    const outcome = await env.DB.prepare(SQL).bind(accountId).all();
    results = outcome.results;
  } catch (err) {
    console.error('[GET /contacts] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  console.log(`[GET /contacts] account=${accountId} count=${results.length}`);
  return json(results);
}

async function handleChats(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  const nameFilter = url.searchParams.get('name') ?? null;

  const SQL = `
    SELECT
      m.tg_chat_id,
      m.chat_name,
      m.chat_type,
      COUNT(m.id) AS message_count,
      MAX(m.sent_at) AS last_message_at,
      COALESCE(cc.sync, 'default') AS sync_status
    FROM messages m
    LEFT JOIN chat_config cc ON cc.account_id = m.account_id AND cc.tg_chat_id = m.tg_chat_id
    WHERE m.account_id = ?
      AND (m.chat_name LIKE ? OR ? IS NULL)
    GROUP BY m.tg_chat_id
    ORDER BY last_message_at DESC
  `.trim();

  const namePattern = nameFilter !== null ? `%${nameFilter}%` : null;

  let results: unknown[];
  try {
    const outcome = await env.DB.prepare(SQL).bind(accountId, namePattern, namePattern).all();
    results = outcome.results;
  } catch (err) {
    console.error('[GET /chats] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  console.log(`[GET /chats] account=${accountId} count=${results.length}`);
  return json(results);
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
    WHERE account_id = ?
  `.trim();

  const CONTACT_SQL = `SELECT COUNT(*) AS total_contacts FROM contacts WHERE account_id = ?`;

  try {
    const [msgResult, contactResult] = await env.DB.batch([
      env.DB.prepare(SQL).bind(accountId),
      env.DB.prepare(CONTACT_SQL).bind(accountId),
    ]);
    const stats = msgResult.results[0] as {
      total_messages: number;
      total_chats: number;
      earliest_message_at: number | null;
      latest_message_at: number | null;
      deleted_count: number;
      edited_count: number;
      sent_count: number;
      received_count: number;
    };
    const contacts = contactResult.results[0] as { total_contacts: number };
    return json({ ...stats, total_contacts: contacts.total_contacts });
  } catch (err) {
    console.error('[GET /stats] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleGetConfig(_request: Request, env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM global_config WHERE key = 'sync_mode'`).first<{ value: string }>();
    return json({ sync_mode: row?.value ?? 'all' });
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

  try {
    await env.DB.prepare(`INSERT INTO global_config (key, value) VALUES ('sync_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(syncMode).run();
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleGetChatsConfig(_request: Request, env: Env, accountId: string): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT tg_chat_id, chat_name, sync, updated_at FROM chat_config WHERE account_id = ? ORDER BY updated_at DESC`
    ).bind(accountId).all();
    return json(results);
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

  try {
    await env.DB.prepare(`
      INSERT INTO chat_config (account_id, tg_chat_id, chat_name, sync, updated_at) VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(account_id, tg_chat_id) DO UPDATE SET chat_name = excluded.chat_name, sync = excluded.sync, updated_at = unixepoch()
    `.trim()).bind(accountId, b.tg_chat_id, b.chat_name ?? null, b.sync).run();
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /chats/config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleDeleteChatsConfig(tgChatId: string, env: Env, accountId: string): Promise<Response> {
  try {
    await env.DB.prepare(`DELETE FROM chat_config WHERE account_id = ? AND tg_chat_id = ?`).bind(accountId, tgChatId).run();
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

  const messages = b.messages as Array<{ tg_chat_id: string; tg_message_id: number }>;
  if (messages.length < 1 || messages.length > 500) {
    return json({ ok: false, error: 'messages array must have 1–500 items' }, 400);
  }

  console.log(`[POST /deleted] account=${accountId} count=${messages.length}`);

  const SQL = `UPDATE messages SET is_deleted = 1, deleted_at = unixepoch() WHERE account_id = ? AND tg_chat_id = ? AND tg_message_id = ?`;
  const stmts = messages.map((m) =>
    env.DB.prepare(SQL).bind(accountId, m.tg_chat_id, m.tg_message_id),
  );

  let results: D1Result[];
  try {
    results = await env.DB.batch(stmts);
  } catch (err) {
    console.error('[POST /deleted] DB batch error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  const marked = results.filter(r => r.meta.rows_written > 0).length;
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

  const SQL = `INSERT OR IGNORE INTO backfill_state (account_id, tg_chat_id, chat_name, total_messages, status) VALUES (?, ?, ?, ?, 'pending')`;

  const stmts = dialogs.map((d) =>
    env.DB.prepare(SQL).bind(accountId, d.tg_chat_id, d.chat_name ?? null, d.total_messages ?? null),
  );

  let results: D1Result[];
  try {
    results = await env.DB.batch(stmts);
  } catch (err) {
    console.error('[POST /backfill/seed] DB batch error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  let seeded = 0;
  for (const result of results) {
    if (result.meta.rows_written > 0) {
      seeded++;
    }
  }

  console.log(`[POST /backfill/seed] seeded=${seeded}`);
  return json({ seeded });
}

async function handleBackfillPending(_request: Request, env: Env, accountId: string): Promise<Response> {
  const SQL = `
    SELECT tg_chat_id, chat_name, total_messages, fetched_messages, oldest_message_id, status
    FROM backfill_state
    WHERE account_id = ? AND status IN ('pending', 'in_progress')
    ORDER BY tg_chat_id
  `.trim();

  try {
    const { results } = await env.DB.prepare(SQL).bind(accountId).all();
    console.log(`[GET /backfill/pending] account=${accountId} count=${results.length}`);
    return json(results);
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

  if (b.status !== undefined) { sets.push('status = ?'); binds.push(b.status as string); }
  if (b.oldest_message_id !== undefined) { sets.push('oldest_message_id = ?'); binds.push(b.oldest_message_id as number); }
  if (b.fetched_messages !== undefined) { sets.push('fetched_messages = ?'); binds.push(b.fetched_messages as number); }
  if (b.last_error !== undefined) { sets.push('last_error = ?'); binds.push(b.last_error as string); }
  if (b.status === 'in_progress') { sets.push('started_at = COALESCE(started_at, unixepoch())'); }
  if (b.status === 'complete' || b.status === 'failed') { sets.push('completed_at = unixepoch()'); }

  if (sets.length === 0) {
    return json({ ok: false, error: 'nothing to update' }, 400);
  }

  binds.push(accountId);
  binds.push(b.tg_chat_id as string);

  console.log(`[POST /backfill/progress] account=${accountId} sets=${sets.length}`);

  try {
    await env.DB.prepare(`UPDATE backfill_state SET ${sets.join(', ')} WHERE account_id = ? AND tg_chat_id = ?`).bind(...binds).run();
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
    description: 'Get messages from one chat in chronological order (oldest first). Use after chats gives you a chat_id. For finding specific content within a chat, prefer search with chat_id filter instead. Paginate by passing the smallest id from the previous page as before_id + its sent_at as before_sent_at.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID (string, may be negative for groups/channels). Get from the chats tool.' },
        limit: { type: 'number', description: 'Messages per page (default 20, max 50).' },
        before_id: { type: 'number', description: 'Pagination: row id of the oldest message from the previous page. Paired with before_sent_at.' },
        before_sent_at: { type: 'number', description: 'Pagination: sent_at (Unix seconds) of the oldest message from the previous page. Paired with before_id.' },
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
    if (typeof args.chat_id !== 'string') throw new Error('chat_id is required');
    const params = new URLSearchParams();
    params.set('chat_id', args.chat_id);
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50);
    params.set('limit', String(limit));
    if (typeof args.before_id === 'number') params.set('before_id', String(args.before_id));
    if (typeof args.before_sent_at === 'number') params.set('before_sent_at', String(args.before_sent_at));
    const req = new Request(`${baseUrl}/search?${params.toString()}`);
    const res = await handleSearch(req, env, accountId);
    const data = await res.json() as { results?: unknown[]; total?: number; limit?: number; next_before_id?: number | null; next_before_sent_at?: number | null };
    // Return chronological order (reverse the DESC-sorted results)
    if (Array.isArray(data.results)) {
      data.results = [...data.results].reverse();
    }
    return data;
  }

  if (name === 'contacts') {
    const req = new Request(`${baseUrl}/contacts`);
    const res = await handleGetContacts(req, env, accountId);
    const data = await res.json() as Array<Record<string, unknown>>;
    if (typeof args.search === 'string' && args.search.trim() !== '') {
      const term = args.search.toLowerCase();
      return data.filter((c) => {
        const name = String(c.first_name ?? '') + ' ' + String(c.last_name ?? '');
        const username = String(c.username ?? '');
        return name.toLowerCase().includes(term) || username.toLowerCase().includes(term);
      });
    }
    return data;
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
): Promise<object> {
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

PAGINATION: search and history return next_before_id + next_before_sent_at. Pass both to the next call to get the next page.

IMPORTANT: The archive is complete and historical. Never tell the user data is unavailable — search with broader terms or a wider date range. If a search returns nothing, try synonyms or remove filters before giving up.`,
      },
    };
  }

  if (method === 'notifications/initialized') {
    return { jsonrpc: '2.0', id, result: null };
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
    const responses = await Promise.all(
      body.map((msg) => handleMcpMessage(msg as Record<string, unknown>, env, accountId)),
    );
    return mcpJson(responses);
  }

  // Single message
  if (typeof body === 'object' && body !== null) {
    const response = await handleMcpMessage(body as Record<string, unknown>, env, accountId);
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

async function fetch(request: Request, env: Env): Promise<Response> {
  // OPTIONS preflight must bypass auth — claude.ai makes cross-origin requests
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const authError = authenticate(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const accountId = request.headers.get('X-Account-ID') ?? url.searchParams.get('account_id') ?? 'primary';
  return route(request, env, accountId);
}

// ---------------------------------------------------------------------------
// Scheduled handler (cron backup)
// ---------------------------------------------------------------------------

async function* streamMessages(db: D1Database): AsyncGenerator<string> {
  const batchSize = 1000;
  let offset = 0;
  while (true) {
    const { results } = await db
      .prepare('SELECT * FROM messages ORDER BY id LIMIT ? OFFSET ?')
      .bind(batchSize, offset)
      .all();
    if (results.length === 0) break;
    for (const row of results) {
      yield JSON.stringify(row) + '\n';
    }
    if (results.length < batchSize) break;
    offset += batchSize;
  }
}

async function runBackup(env: Env): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `backup-${date}.ndjson`;

  try {
    const encoder = new TextEncoder();
    let rowCount = 0;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const line of streamMessages(env.DB)) {
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
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS total_messages, SUM(LENGTH(COALESCE(text, ''))) AS text_bytes FROM messages`,
    ).first<{ total_messages: number; text_bytes: number }>();

    if (!row) return;

    // Conservative estimate: 1 KB per row (covers FTS5 index overhead)
    const estimatedBytes = row.total_messages * 1024;
    const estimatedGB = (estimatedBytes / 1_073_741_824).toFixed(2);
    const textGB = ((row.text_bytes ?? 0) / 1_073_741_824).toFixed(2);

    const level = estimatedBytes > 7 * 1_073_741_824 ? 'WARNING' : 'INFO';
    console.log(
      `[storage-check] ${level} total_messages=${row.total_messages} text_gb=${textGB} estimated_gb=${estimatedGB}`,
    );
    if (level === 'WARNING') {
      console.warn('[storage-check] approaching D1 10 GB limit — consider pruning or exporting old messages');
    }
  } catch (err) {
    console.error('[storage-check] failed', err);
  }
}

async function scheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (event.cron === '0 4 1 * *') {
    await runStorageCheck(env);
  } else {
    await runBackup(env);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default { fetch, scheduled };