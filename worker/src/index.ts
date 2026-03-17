import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import type { Env, Message, OutboxItem, OutboxRecipient, RoleRow, TokenContext } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getSql(env: Env): NeonQueryFunction<false, false> {
  return neon(env.DATABASE_URL);
}

// ISO 8601 from Unix epoch seconds — used in MCP tool outputs for human-readable timestamps.
function toISO(unix: number | null): string | null {
  return unix !== null ? new Date(unix * 1000).toISOString() : null;
}

// SHA-256 hex digest of a string — used for agent token hashing.
async function hashToken(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Safely parse a nullable TEXT JSON column that should be a string array.
function parseJsonColumn(val: unknown): string[] | null {
  if (!val || typeof val !== 'string') return null;
  try {
    const p = JSON.parse(val);
    return Array.isArray(p) ? (p as string[]) : null;
  } catch {
    return null;
  }
}

// Build a parameterized SQL WHERE clause fragment for read-scope enforcement.
// - role null or read_mode='all' → no restriction (empty clause + no binds)
// - whitelist → chat must be in at least one of read_chat_ids OR read_labels chats (OR)
// - blacklist → chat must NOT be in any of read_chat_ids OR read_labels chats (AND NOT)
// nextParam    = next free $N index to use for scope binds
// acctParamIdx = which $N in the outer query holds accountId (for the chat_config subquery)
function buildReadScopeClause(
  role: RoleRow | null,
  tableAlias: string,     // e.g. 'm' for aliased tables, '' for unaliased
  nextParam: number,
  acctParamIdx: number = 1,  // $N that is accountId in the outer query
): { clause: string; binds: unknown[] } {
  if (!role || role.read_mode === 'all') return { clause: '', binds: [] };

  const col = tableAlias ? `${tableAlias}.tg_chat_id` : 'tg_chat_id';
  const binds: unknown[] = [];
  const parts: string[] = [];
  let n = nextParam;

  if (role.read_chat_ids?.length) {
    parts.push(role.read_mode === 'whitelist'
      ? `${col} = ANY($${n}::text[])`
      : `${col} != ALL($${n}::text[])`);
    binds.push(role.read_chat_ids);
    n++;
  }
  if (role.read_labels?.length) {
    parts.push(role.read_mode === 'whitelist'
      ? `${col} IN (SELECT cc.tg_chat_id FROM chat_config cc WHERE cc.account_id = $${acctParamIdx} AND cc.label = ANY($${n}::text[]))`
      : `${col} NOT IN (SELECT cc.tg_chat_id FROM chat_config cc WHERE cc.account_id = $${acctParamIdx} AND cc.label = ANY($${n}::text[]))`);
    binds.push(role.read_labels);
    n++;
  }

  if (parts.length === 0) return { clause: '', binds: [] };

  // whitelist: either condition is enough (OR)
  // blacklist: both NOT conditions must hold (AND)
  const join = role.read_mode === 'whitelist' ? ' OR ' : ' AND ';
  return { clause: `AND (${parts.join(join)})`, binds };
}

// Check write permission for a scoped agent. Returns a permission_denied object on failure,
// or null on success. MASTER_TOKEN callers (role === null) always pass.
function checkWritePermission(
  role: RoleRow | null,
  action: 'send' | 'edit' | 'delete' | 'forward',
  chatType: string | null,
  label: string | null,
  chatId: string,
): { error: string; message: string; action: string; target_chat_type: string | null } | null {
  if (!role) return null; // MASTER_TOKEN — bypass all checks

  const canMap: Record<string, number> = {
    send: role.can_send,
    edit: role.can_edit,
    delete: role.can_delete,
    forward: role.can_forward,
  };
  if (!canMap[action]) {
    return {
      error: 'permission_denied',
      message: `This token cannot ${action}.`,
      action,
      target_chat_type: chatType,
    };
  }

  const writeTypes = role.write_chat_types;
  const writeLabels = role.write_labels;
  const writeChatIds = role.write_chat_ids;
  const hasExplicitWriteScope = writeTypes || writeLabels || writeChatIds;

  if (hasExplicitWriteScope) {
    if (writeTypes && chatType && !writeTypes.includes(chatType)) {
      return {
        error: 'permission_denied',
        message: `This token cannot ${action} to ${chatType} chats. Allowed: ${writeTypes.join(', ')}.`,
        action,
        target_chat_type: chatType,
      };
    }
    if (writeChatIds && !writeChatIds.includes(chatId)) {
      return {
        error: 'permission_denied',
        message: `This token cannot ${action} to chat ${chatId}.`,
        action,
        target_chat_type: chatType,
      };
    }
    if (writeLabels && (!label || !writeLabels.includes(label))) {
      return {
        error: 'permission_denied',
        message: label
          ? `This token cannot ${action} to chats with label "${label}". Allowed: ${writeLabels.join(', ')}.`
          : `This token cannot ${action} to unlabeled chats. Allowed labels: ${writeLabels.join(', ')}.`,
        action,
        target_chat_type: chatType,
      };
    }
    return null; // all active conditions passed
  }

  // No explicit write scope — inherit from read scope
  if (role.read_mode === 'whitelist') {
    const okById = role.read_chat_ids?.includes(chatId) ?? false;
    const okByLabel = label ? (role.read_labels?.includes(label) ?? false) : false;
    if (!okById && !okByLabel) {
      return {
        error: 'permission_denied',
        message: `This token cannot ${action} to chat ${chatId} (out of read scope).`,
        action,
        target_chat_type: chatType,
      };
    }
  } else if (role.read_mode === 'blacklist') {
    const blockedById = role.read_chat_ids?.includes(chatId) ?? false;
    const blockedByLabel = label ? (role.read_labels?.includes(label) ?? false) : false;
    if (blockedById || blockedByLabel) {
      return {
        error: 'permission_denied',
        message: `This token cannot ${action} to chat ${chatId} (blacklisted).`,
        action,
        target_chat_type: chatType,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write permission + audit log helper
// ---------------------------------------------------------------------------

// Shared by send / edit_message / delete_message / forward_message MCP tools.
// Looks up chat_type + label for the target chat, calls checkWritePermission,
// and fires a fire-and-forget audit_log INSERT on success.
// Returns a permission-denied error object, or null if the write is allowed.
async function checkAndAuditWrite(
  action: 'send' | 'edit' | 'delete' | 'forward',
  chatId: string,
  detail: Record<string, unknown>,
  ctx: TokenContext,
  accountId: string,
  env: Env,
): Promise<{ error: string; message: string; action: string; target_chat_type: string | null } | null> {
  if (!ctx.role) return null; // MASTER_TOKEN — bypass
  const sql = getSql(env);
  const chatRows = await sql(
    `SELECT MAX(m.chat_type) AS chat_type, MAX(cc.label) AS label
     FROM messages m
     LEFT JOIN chat_config cc ON cc.account_id = m.account_id AND cc.tg_chat_id = m.tg_chat_id
     WHERE m.account_id = $1 AND m.tg_chat_id = $2`,
    [accountId, chatId],
  ) as Array<{ chat_type: string | null; label: string | null }>;
  const { chat_type, label } = chatRows[0] ?? { chat_type: null, label: null };
  const permErr = checkWritePermission(ctx.role, action, chat_type, label, chatId);
  if (permErr) return permErr;
  if (ctx.token_id !== null) {
    const now = Math.floor(Date.now() / 1000);
    sql(
      `INSERT INTO audit_log (token_id, account_id, action, target_chat_id, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.token_id, accountId, action, chatId, JSON.stringify(detail), now],
    ).catch(() => { /* non-fatal */ });
  }
  return null;
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

// W-1/W-3: timing-safe token check. Used for non-MCP endpoints (INGEST_TOKEN only).
async function authenticate(request: Request, env: Env, tokenOverride?: string | null): Promise<Response | null> {
  const token = tokenOverride ?? request.headers.get('X-Ingest-Token');
  if (!token || !(await timingSafeTokenEqual(token, env.INGEST_TOKEN))) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  return null;
}

// MCP-specific auth — supports three token types:
//   1. MASTER_TOKEN  → full access, no role checks (token_id: null)
//   2. Agent token   → scoped by role from agent_tokens + token_account_roles + roles
//   3. No token      → 401
// tokenOverride is the ?token= query param (for claude.ai connector URLs).
// accountId is required for agent tokens (role is per account).
async function authenticateMcp(
  request: Request,
  env: Env,
  tokenOverride: string | null,
  accountId: string,
): Promise<{ ctx: TokenContext } | { error: Response }> {
  // Prefer Authorization: Bearer header; fall back to ?token= query param
  const authHeader = request.headers.get('Authorization');
  const raw = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? tokenOverride ?? null;
  if (!raw) return { error: json({ ok: false, error: 'Unauthorized' }, 401) };

  // MASTER_TOKEN path — timing-safe comparison
  if (await timingSafeTokenEqual(raw, env.MASTER_TOKEN)) {
    return { ctx: { token_id: null, role: null } };
  }

  // Agent token path — hash the raw token and look up in DB
  const hash = await hashToken(raw);
  const sql = getSql(env);
  const now = Math.floor(Date.now() / 1000);

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await sql(`
      SELECT at.id, at.expires_at, at.last_used_at,
             r.id AS role_id, r.name, r.read_mode,
             r.read_labels, r.read_chat_ids,
             r.can_send, r.can_edit, r.can_delete, r.can_forward,
             r.write_chat_types, r.write_labels, r.write_chat_ids
      FROM agent_tokens at
      JOIN token_account_roles tar ON tar.token_id = at.id AND tar.account_id = $2
      JOIN roles r ON r.id = tar.role_id
      WHERE at.token_hash = $1
      LIMIT 1
    `, [hash, accountId]) as Array<Record<string, unknown>>;
  } catch {
    return { error: json({ ok: false, error: 'Unauthorized' }, 401) };
  }

  if (rows.length === 0) return { error: json({ ok: false, error: 'Unauthorized' }, 401) };
  const row = rows[0];

  // Check expiry
  if (row.expires_at !== null && typeof row.expires_at === 'number' && row.expires_at <= now) {
    return { error: json({ ok: false, error: 'Token expired' }, 401) };
  }

  // Update last_used_at at most once per day — fire-and-forget, non-blocking
  const todayStart = now - (now % 86400);
  sql(
    `UPDATE agent_tokens SET last_used_at = $1 WHERE id = $2 AND (last_used_at IS NULL OR last_used_at < $3)`,
    [now, row.id, todayStart],
  ).catch(() => { /* non-fatal */ });

  const role: RoleRow = {
    id: row.role_id as bigint,
    name: row.name as string,
    read_mode: row.read_mode as RoleRow['read_mode'],
    read_labels: parseJsonColumn(row.read_labels),
    read_chat_ids: parseJsonColumn(row.read_chat_ids),
    can_send: row.can_send as number,
    can_edit: row.can_edit as number,
    can_delete: row.can_delete as number,
    can_forward: row.can_forward as number,
    write_chat_types: parseJsonColumn(row.write_chat_types),
    write_labels: parseJsonColumn(row.write_labels),
    write_chat_ids: parseJsonColumn(row.write_chat_ids),
  };

  return { ctx: { token_id: row.id as bigint, role } };
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
      message_type, text, media_type, media_file_id,
      reply_to_message_id, forwarded_from_id, forwarded_from_name,
      sent_at, edit_date, is_deleted, deleted_at
    )
    SELECT $1,
      v.tg_message_id, v.tg_chat_id, v.chat_name, v.chat_type,
      v.sender_id, v.sender_username, v.sender_first_name, v.sender_last_name,
      v.message_type, v.text, v.media_type, v.media_file_id,
      v.reply_to_message_id, v.forwarded_from_id, v.forwarded_from_name,
      v.sent_at, v.edit_date, v.is_deleted, v.deleted_at
    FROM UNNEST(
      $2::text[], $3::text[], $4::text[], $5::text[],
      $6::text[], $7::text[], $8::text[], $9::text[],
      $10::text[], $11::text[], $12::text[], $13::text[],
      $14::bigint[], $15::text[], $16::text[],
      $17::bigint[], $18::bigint[], $19::smallint[], $20::bigint[]
    ) AS v(
      tg_message_id, tg_chat_id, chat_name, chat_type,
      sender_id, sender_username, sender_first_name, sender_last_name,
      message_type, text, media_type, media_file_id,
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
  const sql = getSql(env);
  let result;
  try {
    result = await sql(SQL, [
      accountId,
      msgs.map(m => m.tg_message_id),
      msgs.map(m => m.tg_chat_id),
      msgs.map(m => m.chat_name ?? null),
      msgs.map(m => m.chat_type ?? null),
      msgs.map(m => m.sender_id ?? null),
      msgs.map(m => m.sender_username ?? null),
      msgs.map(m => m.sender_first_name ?? null),
      msgs.map(m => m.sender_last_name ?? null),
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
    ], { fullResults: true });
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

async function handleSearch(
  request: Request,
  env: Env,
  accountId: string,
  role?: RoleRow | null,
): Promise<Response> {
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

  const sql = getSql(env);

  try {
    let dataRows: Array<{ id: number; sent_at: number }>;
    let total: number;

    if (q !== null) {
      // FTS path: search_vector @@ to_tsquery, sort by recency
      // Base binds: $1=q, $2=accountId, $3=chatId, $4=senderUsername, $5=from, $6=to
      const keysetClause = beforeSentAt !== null && beforeId !== null
        ? `AND (m.sent_at < $7 OR (m.sent_at = $7 AND m.id < $8))`
        : ``;
      const baseBinds: unknown[] = [q, accountId, chatId, senderUsername, from, to];
      const keysetBinds: unknown[] = beforeSentAt !== null && beforeId !== null
        ? [beforeSentAt, beforeId]
        : [];
      // Scope clause: accountId is $2 in FTS path; starts after base + keyset binds
      const { clause: scopeClause, binds: scopeBinds } = buildReadScopeClause(
        role ?? null, 'm', baseBinds.length + keysetBinds.length + 1, 2,
      );
      const limitIdx = baseBinds.length + keysetBinds.length + scopeBinds.length + 1;

      const DATA_SQL = `
        SELECT m.id, m.tg_message_id, m.tg_chat_id, m.chat_name, m.chat_type,
               m.sender_id, m.sender_username, m.sender_first_name, m.sender_last_name,
               m.message_type, m.text, m.media_type,
               m.reply_to_message_id, m.forwarded_from_name, m.sent_at
        FROM messages m
        WHERE m.search_vector @@ to_tsquery('simple', $1)
          AND m.account_id = $2
          AND m.is_deleted = 0
          AND ($3::text IS NULL OR m.tg_chat_id = $3)
          AND ($4::text IS NULL OR m.sender_username = $4
            OR m.sender_id IN (SELECT tg_user_id FROM contacts WHERE account_id = $2 AND username = $4))
          AND m.sent_at >= $5
          AND m.sent_at <= $6
          ${keysetClause}
          ${scopeClause}
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT $${limitIdx}
      `.trim();

      const COUNT_SQL = `
        SELECT COUNT(*) AS total
        FROM messages m
        WHERE m.search_vector @@ to_tsquery('simple', $1)
          AND m.account_id = $2
          AND m.is_deleted = 0
          AND ($3::text IS NULL OR m.tg_chat_id = $3)
          AND ($4::text IS NULL OR m.sender_username = $4
            OR m.sender_id IN (SELECT tg_user_id FROM contacts WHERE account_id = $2 AND username = $4))
          AND m.sent_at >= $5
          AND m.sent_at <= $6
          ${keysetClause}
          ${scopeClause}
      `.trim();

      const allBinds = [...baseBinds, ...keysetBinds, ...scopeBinds];
      const [dataResult, countResult] = await Promise.all([
        sql(DATA_SQL, [...allBinds, limit]),
        sql(COUNT_SQL, allBinds),
      ]);
      dataRows = dataResult as Array<{ id: number; sent_at: number }>;
      total = parseInt((countResult[0] as { total: string }).total, 10);
    } else {
      // B-tree path: no query, sort by recency
      // Base binds: $1=accountId, $2=chatId, $3=senderUsername, $4=from, $5=to
      const keysetClause = beforeSentAt !== null && beforeId !== null
        ? `AND (sent_at < $6 OR (sent_at = $6 AND id < $7))`
        : ``;
      const baseBinds: unknown[] = [accountId, chatId, senderUsername, from, to];
      const keysetBinds: unknown[] = beforeSentAt !== null && beforeId !== null
        ? [beforeSentAt, beforeId]
        : [];
      // Scope clause: accountId is $1 in B-tree path; starts after base + keyset binds
      const { clause: scopeClause, binds: scopeBinds } = buildReadScopeClause(
        role ?? null, '', baseBinds.length + keysetBinds.length + 1, 1,
      );
      const limitIdx = baseBinds.length + keysetBinds.length + scopeBinds.length + 1;

      const DATA_SQL = `
        SELECT id, tg_message_id, tg_chat_id, chat_name, chat_type,
               sender_id, sender_username, sender_first_name, sender_last_name,
               message_type, text, media_type,
               reply_to_message_id, forwarded_from_name, sent_at
        FROM messages
        WHERE account_id = $1
          AND is_deleted = 0
          AND ($2::text IS NULL OR tg_chat_id = $2)
          AND ($3::text IS NULL OR sender_username = $3
            OR sender_id IN (SELECT tg_user_id FROM contacts WHERE account_id = $1 AND username = $3))
          AND sent_at >= $4
          AND sent_at <= $5
          ${keysetClause}
          ${scopeClause}
        ORDER BY sent_at DESC, id DESC
        LIMIT $${limitIdx}
      `.trim();

      const COUNT_SQL = `
        SELECT COUNT(*) AS total
        FROM messages
        WHERE account_id = $1
          AND is_deleted = 0
          AND ($2::text IS NULL OR tg_chat_id = $2)
          AND ($3::text IS NULL OR sender_username = $3
            OR sender_id IN (SELECT tg_user_id FROM contacts WHERE account_id = $1 AND username = $3))
          AND sent_at >= $4
          AND sent_at <= $5
          ${keysetClause}
          ${scopeClause}
      `.trim();

      const allBinds = [...baseBinds, ...keysetBinds, ...scopeBinds];
      const [dataResult, countResult] = await Promise.all([
        sql(DATA_SQL, [...allBinds, limit]),
        sql(COUNT_SQL, allBinds),
      ]);
      dataRows = dataResult as Array<{ id: number; sent_at: number }>;
      total = parseInt((countResult[0] as { total: string }).total, 10);
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
  const sql = getSql(env);
  let result;
  try {
    result = await sql(SQL, [
      accountId,
      cs.map(c => c.tg_user_id),
      cs.map(c => c.phone ?? null),
      cs.map(c => c.username ?? null),
      cs.map(c => c.first_name ?? null),
      cs.map(c => c.last_name ?? null),
      cs.map(c => c.is_mutual ?? null),
      cs.map(c => c.is_bot ?? null),
    ], { fullResults: true });
  } catch (err) {
    console.error('[POST /contacts] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }

  const upserted = result.rowCount ?? 0;
  console.log(`[POST /contacts] upserted=${upserted}`);
  return json({ upserted });
}

async function handleGetContacts(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  const hasMessages = url.searchParams.get('has_messages') === 'true';
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
    HAVING ($2::boolean IS NOT TRUE OR COUNT(m.id) > 0)
    ORDER BY last_seen DESC NULLS LAST
  `.trim();

  const sql = getSql(env);
  try {
    const rows = await sql(SQL, [accountId, hasMessages || null]) as Array<{
      tg_user_id: string; phone: string | null; username: string | null;
      first_name: string | null; last_name: string | null;
      is_mutual: number; is_bot: number;
      message_count: string; last_seen: string | null;
    }>;
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

async function handleChats(
  request: Request,
  env: Env,
  accountId: string,
  role?: RoleRow | null,
): Promise<Response> {
  const url = new URL(request.url);
  const nameFilter = url.searchParams.get('name') ?? null;
  const labelFilter = url.searchParams.get('label') ?? null;
  const chatTypeFilter = url.searchParams.get('chat_type') ?? null;
  const unansweredOnly = url.searchParams.get('filter') === 'unanswered';
  const sortBy = url.searchParams.get('sort_by') ?? 'last_activity';
  const orderClause = sortBy === 'message_count' ? 'message_count DESC' : 'last_message_at DESC';

  // W-6: escape LIKE metacharacters so % and _ in nameFilter are treated as literals
  const namePattern = nameFilter !== null
    ? `%${nameFilter.replace(/[%_\\]/g, '\\$&')}%`
    : null;

  // Base binds: $1=accountId, $2=namePattern, $3=labelFilter, $4=chatTypeFilter, $5=unansweredOnly
  // Scope clause: accountId is $1; starts at $6
  const { clause: scopeClause, binds: scopeBinds } = buildReadScopeClause(role ?? null, 'm', 6, 1);

  // GROUP BY tg_chat_id only — avoids duplicate rows if chat_name/type changed over time.
  // MAX(chat_name)/MAX(chat_type) picks a deterministic canonical value per chat.
  const SQL = `
    SELECT
      m.tg_chat_id,
      MAX(m.chat_name) AS chat_name,
      MAX(m.chat_type) AS chat_type,
      COUNT(m.id) AS message_count,
      MAX(m.sent_at) AS last_message_at,
      COALESCE(MAX(cc.sync), 'default') AS sync_status,
      MAX(cc.label) AS label
    FROM messages m
    LEFT JOIN chat_config cc ON cc.account_id = m.account_id AND cc.tg_chat_id = m.tg_chat_id
    WHERE m.account_id = $1
      AND ($2::text IS NULL OR m.chat_name ILIKE $2)
      AND ($3::text IS NULL OR cc.label = $3)
      AND ($4::text IS NULL OR m.chat_type = $4)
      ${scopeClause}
    GROUP BY m.tg_chat_id
    HAVING ($5::boolean IS NOT TRUE OR (
      MAX(CASE WHEN m.sender_id != $1 THEN m.sent_at ELSE 0 END) >
      MAX(CASE WHEN m.sender_id = $1 THEN m.sent_at ELSE 0 END)
    ))
    ORDER BY ${orderClause}
  `.trim();

  const sql = getSql(env);
  try {
    const rows = await sql(
      SQL,
      [accountId, namePattern, labelFilter, chatTypeFilter, unansweredOnly || null, ...scopeBinds],
    ) as Array<{
      tg_chat_id: string; chat_name: string | null; chat_type: string | null;
      message_count: string; last_message_at: string | null; sync_status: string; label: string | null;
    }>;
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
      SUM(CASE WHEN edit_date IS NOT NULL THEN 1 ELSE 0 END) AS edited_count
    FROM messages
    WHERE account_id = $1
  `.trim();

  const CONTACT_SQL = `SELECT COUNT(*) AS total_contacts FROM contacts WHERE account_id = $1`;

  const sql = getSql(env);
  try {
    const [msgResult, contactResult] = await Promise.all([
      sql(SQL, [accountId]) as unknown as Promise<Array<{
        total_messages: string;
        total_chats: string;
        earliest_message_at: number | null;
        latest_message_at: number | null;
        deleted_count: string;
        edited_count: string;
      }>>,
      sql(CONTACT_SQL, [accountId]) as unknown as Promise<Array<{ total_contacts: string }>>,
    ]);
    const stats = msgResult[0];
    const total_contacts = parseInt(contactResult[0].total_contacts, 10);
    // my_user_id: if accountId is numeric (the user's own TG ID), expose it for MCP consumers
    const my_user_id = /^\d+$/.test(accountId) ? accountId : null;
    return json({
      total_messages: parseInt(stats.total_messages, 10),
      total_chats: parseInt(stats.total_chats, 10),
      earliest_message_at: stats.earliest_message_at,
      latest_message_at: stats.latest_message_at,
      deleted_count: parseInt(stats.deleted_count, 10),
      edited_count: parseInt(stats.edited_count, 10),
      total_contacts,
      my_user_id,
    });
  } catch (err) {
    console.error('[GET /stats] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}


async function handleGetConfig(_request: Request, env: Env, accountId: string): Promise<Response> {
  const sql = getSql(env);
  try {
    // Account-specific setting takes precedence over global default.
    const rows = await sql(
      `SELECT value FROM global_config
       WHERE key = 'sync_mode' AND account_id IN ($1, 'global')
       ORDER BY CASE WHEN account_id = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [accountId],
    ) as Array<{ value: string }>;
    return json({ sync_mode: rows[0]?.value ?? 'all' });
  } catch (err) {
    console.error('[GET /config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handlePostConfig(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const syncMode = (body as Record<string, unknown>).sync_mode;
  if (!VALID_SYNC_MODES.includes(syncMode as typeof VALID_SYNC_MODES[number])) {
    return json({ ok: false, error: `sync_mode must be one of: ${VALID_SYNC_MODES.join(', ')}` }, 400);
  }

  const sql = getSql(env);
  try {
    await sql(
      `INSERT INTO global_config (account_id, key, value) VALUES ($1, 'sync_mode', $2) ON CONFLICT(account_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [accountId, syncMode],
    );
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleGetChatsConfig(_request: Request, env: Env, accountId: string): Promise<Response> {
  const sql = getSql(env);
  try {
    const rows = await sql(
      `SELECT tg_chat_id, chat_name, sync, label, updated_at FROM chat_config WHERE account_id = $1 ORDER BY updated_at DESC`,
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
  if (b.sync !== undefined && !VALID_CHAT_SYNC_VALUES.includes(b.sync as typeof VALID_CHAT_SYNC_VALUES[number])) {
    return json({ ok: false, error: `sync must be 'include' or 'exclude'` }, 400);
  }
  const syncVal = b.sync ?? null;
  const labelVal = typeof b.label === 'string' ? b.label : null;

  const sql = getSql(env);
  try {
    await sql(
      `INSERT INTO chat_config (account_id, tg_chat_id, chat_name, sync, label, updated_at)
       VALUES ($1, $2, $3, $4, $5, EXTRACT(EPOCH FROM NOW())::BIGINT)
       ON CONFLICT(account_id, tg_chat_id) DO UPDATE SET
         chat_name = EXCLUDED.chat_name,
         sync = COALESCE(EXCLUDED.sync, chat_config.sync),
         label = COALESCE(EXCLUDED.label, chat_config.label),
         updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
      [accountId, b.tg_chat_id, b.chat_name ?? null, syncVal, labelVal],
    );
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /chats/config] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleDeleteChatsConfig(tgChatId: string, env: Env, accountId: string): Promise<Response> {
  const sql = getSql(env);
  try {
    await sql(
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

  const sql = getSql(env);
  let result;
  try {
    result = await sql(SQL, [
      accountId,
      messages.map(m => m.tg_chat_id),
      messages.map(m => m.tg_message_id),
    ], { fullResults: true });
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

  const sql = getSql(env);
  let result;
  try {
    result = await sql(SQL, [
      accountId,
      dialogs.map(d => d.tg_chat_id),
      dialogs.map(d => d.chat_name ?? null),
      dialogs.map(d => d.total_messages ?? null),
    ], { fullResults: true });
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

  const sql = getSql(env);
  try {
    const rows = await sql(SQL, [accountId]);
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
  if (b.total_messages !== undefined) {
    if (typeof b.total_messages !== 'number' || !Number.isInteger(b.total_messages)) {
      return json({ ok: false, error: 'total_messages must be an integer' }, 400);
    }
    sets.push(`total_messages = COALESCE(total_messages, ${next()})`); binds.push(b.total_messages);
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

  const sql = getSql(env);
  try {
    await sql(SQL, binds);
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /backfill/progress] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// Outbox — drafts, scheduled sends, replies, mass sends
// ---------------------------------------------------------------------------

const VALID_OUTBOX_STATUSES = ['draft', 'scheduled', 'pending', 'sending', 'sent', 'failed', 'partial'] as const;

async function handlePostOutbox(request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string' || b.text.trim() === '') {
    return json({ ok: false, error: 'text is required' }, 400);
  }

  const recipients = Array.isArray(b.recipients) ? (b.recipients as Array<Record<string, unknown>>) : null;
  const isMass = recipients !== null && recipients.length > 0;
  if (!isMass && (typeof b.tg_chat_id !== 'string' || !b.tg_chat_id)) {
    return json({ ok: false, error: 'tg_chat_id is required for single sends' }, 400);
  }

  const requestedStatus = (b.status as string) ?? 'draft';
  if (!VALID_OUTBOX_STATUSES.includes(requestedStatus as typeof VALID_OUTBOX_STATUSES[number])) {
    return json({ ok: false, error: `status must be one of: ${VALID_OUTBOX_STATUSES.join(', ')}` }, 400);
  }
  const scheduledAt = typeof b.scheduled_at === 'number' ? b.scheduled_at : null;
  if (requestedStatus === 'scheduled' && scheduledAt === null) {
    return json({ ok: false, error: 'scheduled_at (unix epoch seconds) is required when status is "scheduled"' }, 400);
  }

  const replyTo = typeof b.reply_to_message_id === 'number' ? b.reply_to_message_id : null;
  const tgChatId = !isMass ? (b.tg_chat_id as string) : null;
  const now = Math.floor(Date.now() / 1000);

  const sql = getSql(env);
  try {
    const outboxRows = await sql(
      `INSERT INTO outbox (account_id, tg_chat_id, reply_to_message_id, text, status, scheduled_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [accountId, tgChatId, replyTo, b.text as string, requestedStatus, scheduledAt, now],
    ) as Array<{ id: number }>;
    const outboxId = outboxRows[0].id;

    if (isMass && recipients!.length > 0) {
      await sql(
        `INSERT INTO outbox_recipients (outbox_id, tg_chat_id, first_name, username, last_name)
         SELECT $1, v.tg_chat_id, v.first_name, v.username, v.last_name
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[]) AS v(tg_chat_id, first_name, username, last_name)`,
        [
          outboxId,
          recipients!.map(r => r.tg_chat_id as string),
          recipients!.map(r => (r.first_name as string) ?? null),
          recipients!.map(r => (r.username as string) ?? null),
          recipients!.map(r => (r.last_name as string) ?? null),
        ],
      );
    }

    console.log(`[POST /outbox] account=${accountId} id=${outboxId} status=${requestedStatus} mass=${isMass} recipients=${recipients?.length ?? 0}`);
    return json({ id: outboxId, status: requestedStatus });
  } catch (err) {
    console.error('[POST /outbox] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleGetOutbox(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status') ?? null;
  if (statusFilter !== null && !VALID_OUTBOX_STATUSES.includes(statusFilter as typeof VALID_OUTBOX_STATUSES[number])) {
    return json({ ok: false, error: `status must be one of: ${VALID_OUTBOX_STATUSES.join(', ')}` }, 400);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

  const sql = getSql(env);
  try {
    const rows = await sql(
      `SELECT id, tg_chat_id, reply_to_message_id, text, status, scheduled_at, error, created_at, updated_at, sent_at
       FROM outbox
       WHERE account_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [accountId, statusFilter, limit, offset],
    );
    return json(rows);
  } catch (err) {
    console.error('[GET /outbox] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

// GET /outbox/due — atomically claims pending/due-scheduled items for GramJS to process.
// Uses a single CTE statement (atomic in PostgreSQL) to reset stuck + claim due items.
async function handleGetOutboxDue(_request: Request, env: Env, accountId: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const sql = getSql(env);
  try {
    // Single atomic CTE: reset stuck 'sending' items (>5 min) then claim due items.
    // Also reset recipients of stuck mass sends so they can be retried.
    const rows = await sql(
      `WITH reset_stuck AS (
         UPDATE outbox
         SET status = 'pending', updated_at = $1
         WHERE account_id = $2
           AND status = 'sending'
           AND updated_at < $1 - 300
         RETURNING id
       ),
       reset_stuck_recipients AS (
         -- Reset failed recipients so they are retried; leave 'sent' ones alone (no double-send)
         UPDATE outbox_recipients
         SET status = 'pending'
         WHERE outbox_id IN (SELECT id FROM reset_stuck)
           AND status = 'failed'
       ),
       claimed AS (
         UPDATE outbox
         SET status = 'sending', updated_at = $1
         WHERE id IN (
           SELECT id FROM outbox
           WHERE account_id = $2
             AND (
               (status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= $1))
               OR (status = 'scheduled' AND scheduled_at <= $1)
             )
           ORDER BY id
           LIMIT 10
         )
         RETURNING id, tg_chat_id, reply_to_message_id, text, scheduled_at, sent_at, created_at, updated_at
       )
       SELECT c.*, 'sending' AS status FROM claimed c`,
      [now, accountId],
    ) as Array<OutboxItem>;

    if (rows.length === 0) return json([]);

    // Fetch recipients for mass sends
    const massIds = rows.filter(r => r.tg_chat_id === null).map(r => r.id);
    let recipientMap: Map<number, OutboxRecipient[]> = new Map();
    if (massIds.length > 0) {
      const recpRows = await sql(
        `SELECT id, outbox_id, tg_chat_id, first_name, username, last_name, status, sent_at, error
         FROM outbox_recipients
         WHERE outbox_id = ANY($1::bigint[]) AND status = 'pending'`,
        [massIds],
      ) as Array<OutboxRecipient & { outbox_id: number }>;
      for (const r of recpRows) {
        if (!recipientMap.has(r.outbox_id)) recipientMap.set(r.outbox_id, []);
        recipientMap.get(r.outbox_id)!.push(r);
      }
    }

    const items = rows.map(r => ({
      ...r,
      recipients: recipientMap.get(r.id) ?? undefined,
    }));

    console.log(`[GET /outbox/due] account=${accountId} claimed=${rows.length}`);
    return json(items);
  } catch (err) {
    console.error('[GET /outbox/due] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handlePatchOutbox(outboxId: number, request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const b = body as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ['updated_at = $1'];
  const binds: unknown[] = [now];
  let p = 1;

  if (typeof b.text === 'string') { p++; sets.push(`text = $${p}`); binds.push(b.text); }
  if (typeof b.scheduled_at === 'number' || b.scheduled_at === null) { p++; sets.push(`scheduled_at = $${p}`); binds.push(b.scheduled_at ?? null); }
  if (typeof b.tg_chat_id === 'string') { p++; sets.push(`tg_chat_id = $${p}`); binds.push(b.tg_chat_id); }

  if (sets.length === 1) return json({ ok: false, error: 'nothing to update' }, 400);

  p++; binds.push(accountId);
  p++; binds.push(outboxId);

  const sql = getSql(env);
  try {
    const rows = await sql(
      `UPDATE outbox SET ${sets.join(', ')} WHERE account_id = $${p - 1} AND id = $${p} AND status = 'draft' RETURNING id`,
      binds,
    ) as Array<{ id: number }>;
    if (rows.length === 0) return json({ ok: false, error: 'draft not found or not in draft status' }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error('[PATCH /outbox/:id] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleDeleteOutbox(outboxId: number, env: Env, accountId: string): Promise<Response> {
  const sql = getSql(env);
  try {
    const rows = await sql(
      `DELETE FROM outbox WHERE account_id = $1 AND id = $2 AND status = 'draft' RETURNING id`,
      [accountId, outboxId],
    ) as Array<{ id: number }>;
    if (rows.length === 0) return json({ ok: false, error: 'draft not found or not in draft status' }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error('[DELETE /outbox/:id] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleSendOutbox(outboxId: number, request: Request, env: Env, accountId: string): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body ok */ }

  const scheduledAt = typeof body.scheduled_at === 'number' ? body.scheduled_at : null;
  const newStatus = scheduledAt !== null ? 'scheduled' : 'pending';

  const sql = getSql(env);
  try {
    const rows = await sql(
      `UPDATE outbox SET status = $1, scheduled_at = $2, updated_at = $3
       WHERE account_id = $4 AND id = $5 AND status = 'draft'
       RETURNING id`,
      [newStatus, scheduledAt, Math.floor(Date.now() / 1000), accountId, outboxId],
    ) as Array<{ id: number }>;
    if (rows.length === 0) return json({ ok: false, error: 'draft not found or not in draft status' }, 404);
    return json({ ok: true, status: newStatus });
  } catch (err) {
    console.error('[POST /outbox/:id/send] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleAckOutbox(outboxId: number, request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const b = body as Record<string, unknown>;
  const status = b.status as string;
  if (!['sent', 'failed', 'partial'].includes(status)) {
    return json({ ok: false, error: 'status must be sent, failed, or partial' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const sentAt = typeof b.sent_at === 'number' ? b.sent_at : now;
  const error = typeof b.error === 'string' ? b.error : null;

  const sql = getSql(env);
  try {
    await sql(
      `UPDATE outbox SET status = $1, sent_at = $2, error = $3, updated_at = $4
       WHERE account_id = $5 AND id = $6`,
      [status, sentAt, error, now, accountId, outboxId],
    );

    // Update per-recipient results if provided
    const results = Array.isArray(b.results) ? (b.results as Array<Record<string, unknown>>) : null;
    if (results && results.length > 0) {
      for (const r of results) {
        if (typeof r.id !== 'number') continue;
        await sql(
          `UPDATE outbox_recipients SET status = $1, sent_at = $2, error = $3
           WHERE id = $4 AND outbox_id = $5`,
          [r.status ?? 'sent', r.sent_at ?? now, r.error ?? null, r.id, outboxId],
        );
      }
    }

    console.log(`[POST /outbox/${outboxId}/ack] account=${accountId} status=${status}`);
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /outbox/:id/ack] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// Pending actions — edit / delete / forward on already-sent messages
// ---------------------------------------------------------------------------

async function handlePostAction(request: Request, env: Env, accountId: string, action: 'edit' | 'delete' | 'forward'): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const b = body as Record<string, unknown>;
  if (typeof b.tg_chat_id !== 'string' || !b.tg_chat_id) {
    return json({ ok: false, error: 'tg_chat_id is required' }, 400);
  }
  if (typeof b.tg_message_id !== 'string' || !b.tg_message_id) {
    return json({ ok: false, error: 'tg_message_id is required' }, 400);
  }
  if (action === 'edit' && (typeof b.text !== 'string' || !b.text)) {
    return json({ ok: false, error: 'text is required for edit' }, 400);
  }
  if (action === 'forward' && (typeof b.to_chat_id !== 'string' || !b.to_chat_id)) {
    return json({ ok: false, error: 'to_chat_id is required for forward' }, 400);
  }

  const sql = getSql(env);
  try {
    const rows = await sql(
      `INSERT INTO pending_actions (account_id, action, tg_chat_id, tg_message_id, text, to_chat_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        accountId,
        action,
        b.tg_chat_id,
        b.tg_message_id,
        action === 'edit' ? b.text : null,
        action === 'forward' ? b.to_chat_id : null,
        Math.floor(Date.now() / 1000),
      ],
    ) as Array<{ id: number }>;
    console.log(`[POST /actions/${action}] account=${accountId} id=${rows[0].id} chat=${b.tg_chat_id} msg=${b.tg_message_id}`);
    return json({ id: rows[0].id, action, status: 'pending' });
  } catch (err) {
    console.error(`[POST /actions/${action}] DB error`, err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleGetActionsPending(_request: Request, env: Env, accountId: string): Promise<Response> {
  const sql = getSql(env);
  try {
    const rows = await sql(
      `SELECT id, action, tg_chat_id, tg_message_id, text, to_chat_id, created_at
       FROM pending_actions
       WHERE account_id = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [accountId],
    );
    return json(rows);
  } catch (err) {
    console.error('[GET /actions/pending] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

async function handleAckAction(actionId: number, request: Request, env: Env, accountId: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const b = body as Record<string, unknown>;
  const status = b.status as string;
  if (!['done', 'failed'].includes(status)) {
    return json({ ok: false, error: 'status must be done or failed' }, 400);
  }

  const sql = getSql(env);
  try {
    await sql(
      `UPDATE pending_actions SET status = $1, error = $2 WHERE account_id = $3 AND id = $4`,
      [status, typeof b.error === 'string' ? b.error : null, accountId, actionId],
    );
    console.log(`[POST /actions/${actionId}/ack] account=${accountId} status=${status}`);
    return json({ ok: true });
  } catch (err) {
    console.error('[POST /actions/:id/ack] DB error', err);
    return json({ ok: false, error: 'DB error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — Streamable HTTP transport, spec 2024-11-05
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Token, X-Account-ID, Authorization',
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
    description: 'Full-text search across the complete Telegram message archive (51k+ messages). Results are ranked by recency. Use for any question about past conversations, finding specific messages, amounts, names, or topics. Always use from/to when the user mentions a time period. IMPORTANT: multiple words are ANDed — every word must appear in the message. If a broad search returns 0 results, retry with a single shorter token (e.g. "blackbox" instead of "blackbox network"). For sender-specific searches, use sender_username (resolved via contacts if needed). Paginate with next_before_id + next_before_sent_at from the previous response.',
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
    description: 'List all Telegram chats (groups, channels, DMs) with message counts and last activity. Use to discover chat IDs before calling history, or to find which chat a conversation happened in. Optionally filter by name, label, chat type, or who wrote last.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional. Filter chats by name (case-insensitive partial match). Example: "DevOps" matches "DevOps Team" and "devops-general".' },
        label: { type: 'string', description: 'Optional. Filter by label (e.g. "work", "personal"). Only returns chats that have that label set in chat_config.' },
        chat_type: { type: 'string', enum: ['user', 'group', 'supergroup', 'channel'], description: 'Optional. Filter by chat type: "user" for DMs, "group" for basic groups, "supergroup" for large groups, "channel" for broadcast channels.' },
        filter: { type: 'string', enum: ['unanswered'], description: 'Optional. "unanswered" returns only chats where someone else wrote the last message (you haven\'t replied). Useful for CRM-style follow-up queries.' },
        sort_by: { type: 'string', enum: ['last_activity', 'message_count'], description: 'Optional. Sort order: "last_activity" (default, newest message first) or "message_count" (most messages first, use for "most active chats").' },
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
    description: 'List Telegram contacts with username, name, and message count. Use to find someone\'s tg_user_id or username before searching their messages, or to see who you talk to most. Note: contacts are people saved in your phone — group members without a saved contact may not appear here. Use has_messages: true to filter out phone contacts who never messaged on Telegram.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional. Filter by name or username (case-insensitive partial match).' },
        has_messages: { type: 'boolean', description: 'Optional. If true, only return contacts who have at least one message in the archive. Filters out phone contacts with no Telegram message history.' },
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
  {
    name: 'digest',
    description: 'Get a digest of recent messages grouped by chat, showing the latest N messages per active chat. Use this for "what happened today/this week", morning briefings, or to catch up on activity across all chats. Each chat entry includes its label (work/personal) when set.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Look-back window in hours (default 24). Use 168 for a weekly digest.' },
        per_chat: { type: 'number', description: 'Max messages per chat to return (default 5, max 20).' },
        label: { type: 'string', description: 'Optional. Filter to chats with this label (e.g. "work").' },
      },
    },
  },
  {
    name: 'thread',
    description: 'Get a message and its reply thread (parent + all direct replies). Use when you want to see the full context of a conversation around a specific message. Paginate with next_after_id from the previous response.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID containing the message.' },
        message_id: { type: 'string', description: 'The tg_message_id of the message to reconstruct the thread around.' },
        limit: { type: 'number', description: 'Max replies to return (default 50, max 200).' },
        after_id: { type: 'number', description: 'Pagination: pass next_after_id from the previous response.' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'send',
    description: 'Queue a Telegram message for immediate sending (or schedule it). For single-chat sends, provide tg_chat_id. For mass sends, provide a recipients array. GramJS picks it up within 30 seconds. Returns the outbox id.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Target chat ID for a single send. Omit for mass send.' },
        text: { type: 'string', description: 'Message text. Supports {first_name}, {last_name}, {username}, {user} placeholders for mass sends.' },
        reply_to_message_id: { type: 'number', description: 'Optional. Reply to this message ID.' },
        scheduled_at: { type: 'number', description: 'Optional. Unix epoch seconds to send at. Omit to send immediately.' },
        recipients: { type: 'array', description: 'For mass send: array of {tg_chat_id, first_name?, last_name?, username?} objects.', items: { type: 'object' } },
      },
      required: ['text'],
    },
  },
  {
    name: 'draft',
    description: 'Save a message as a draft (not queued for sending yet). Returns the outbox id. Use send tool or POST /outbox/:id/send to promote to pending/scheduled later.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Target chat ID for a single send.' },
        text: { type: 'string', description: 'Message text. Supports {first_name}, {last_name}, {username}, {user} placeholders.' },
        reply_to_message_id: { type: 'number', description: 'Optional. Reply to this message ID.' },
        recipients: { type: 'array', description: 'For mass send drafts.', items: { type: 'object' } },
      },
      required: ['text'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit an already-sent Telegram message. Queues an edit action; GramJS executes it within 30 seconds and the archive is updated automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Chat ID of the message to edit.' },
        tg_message_id: { type: 'string', description: 'Message ID to edit.' },
        text: { type: 'string', description: 'New text for the message.' },
      },
      required: ['tg_chat_id', 'tg_message_id', 'text'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete an already-sent Telegram message (revokes from both sides). Queues a delete action; GramJS executes it within 30 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Chat ID of the message to delete.' },
        tg_message_id: { type: 'string', description: 'Message ID to delete.' },
      },
      required: ['tg_chat_id', 'tg_message_id'],
    },
  },
  {
    name: 'forward_message',
    description: 'Forward an existing Telegram message to another chat. Queues a forward action; GramJS executes it within 30 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Source chat ID.' },
        tg_message_id: { type: 'string', description: 'Message ID to forward.' },
        to_chat_id: { type: 'string', description: 'Destination chat ID.' },
      },
      required: ['tg_chat_id', 'tg_message_id', 'to_chat_id'],
    },
  },
  {
    name: 'outbox_status',
    description: 'Check the delivery status of a sent or scheduled message by its outbox id. Returns status (pending/sending/sent/failed/scheduled/partial), sent_at, and any error. Use after send to confirm delivery, or to check if a scheduled message is still queued.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Outbox id returned by the send or draft tool.' },
      },
      required: ['id'],
    },
  },
  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------
  {
    name: 'whoami',
    description: 'Return the identity and permissions of the current caller. Shows whether using MASTER_TOKEN or a scoped agent token, and the associated role with read/write capabilities.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ---------------------------------------------------------------------------
  // Role management — MASTER_TOKEN only
  // ---------------------------------------------------------------------------
  {
    name: 'create_role',
    description: 'Create a new RBAC role. MASTER_TOKEN required. Roles define read scope (all/whitelist/blacklist), write permissions (can_send, can_edit, can_delete, can_forward), and optional write scope overrides.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique role name (e.g. "work-reader", "dm-assistant").' },
        read_mode: { type: 'string', enum: ['all', 'whitelist', 'blacklist'], description: 'Read scope mode. "all" = no restriction. "whitelist" = only allowed chats. "blacklist" = all except blocked chats.' },
        read_labels: { type: 'array', items: { type: 'string' }, description: 'Optional. For whitelist/blacklist: filter by chat labels (e.g. ["work", "clients"]).' },
        read_chat_ids: { type: 'array', items: { type: 'string' }, description: 'Optional. For whitelist/blacklist: filter by specific tg_chat_ids.' },
        can_send: { type: 'boolean', description: 'Allow sending messages (default false).' },
        can_edit: { type: 'boolean', description: 'Allow editing sent messages (default false).' },
        can_delete: { type: 'boolean', description: 'Allow deleting messages (default false).' },
        can_forward: { type: 'boolean', description: 'Allow forwarding messages (default false).' },
        write_chat_types: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict writes to these chat types (e.g. ["user"]). Null = inherit read scope.' },
        write_labels: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict writes to chats with these labels. Null = inherit read scope.' },
        write_chat_ids: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict writes to these specific chat IDs. Null = inherit read scope.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_roles',
    description: 'List all RBAC roles with their permissions and scope configuration. MASTER_TOKEN required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_role',
    description: 'Update fields on an existing role by name. Only provided fields are changed. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Current name of the role to update.' },
        new_name: { type: 'string', description: 'Rename the role to this value.' },
        read_mode: { type: 'string', enum: ['all', 'whitelist', 'blacklist'] },
        read_labels: { type: 'array', items: { type: 'string' } },
        read_chat_ids: { type: 'array', items: { type: 'string' } },
        can_send: { type: 'boolean' },
        can_edit: { type: 'boolean' },
        can_delete: { type: 'boolean' },
        can_forward: { type: 'boolean' },
        write_chat_types: { type: 'array', items: { type: 'string' } },
        write_labels: { type: 'array', items: { type: 'string' } },
        write_chat_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_role',
    description: 'Delete a role by name. Fails if any token still references this role. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the role to delete.' },
      },
      required: ['name'],
    },
  },
  // ---------------------------------------------------------------------------
  // Token management — MASTER_TOKEN only
  // ---------------------------------------------------------------------------
  {
    name: 'create_token',
    description: 'Create a scoped agent token bound to a role for one or more accounts. Returns the raw token once — store it securely, it cannot be recovered. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role name to bind this token to.' },
        label: { type: 'string', description: 'Optional human-readable label (e.g. "Claude work assistant").' },
        account_id: { type: 'string', description: 'Account to bind to. Defaults to "primary".' },
        expires_at: { type: 'number', description: 'Optional. Unix epoch seconds expiry. Omit for no expiry.' },
      },
      required: ['role'],
    },
  },
  {
    name: 'list_tokens',
    description: 'List all agent tokens with their label, role, expiry, and last-used timestamp. Raw token values are never returned. MASTER_TOKEN required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revoke_token',
    description: 'Permanently delete an agent token by its numeric ID. The associated token_account_roles rows are cascade-deleted. Audit log rows are preserved. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        token_id: { type: 'string', description: 'Token ID (string) as returned by list_tokens.' },
      },
      required: ['token_id'],
    },
  },
  // ---------------------------------------------------------------------------
  // Observer job management — MASTER_TOKEN only
  // ---------------------------------------------------------------------------
  {
    name: 'create_job',
    description: 'Create an observer job that runs an AI agent on a schedule or trigger. Auto-creates a scoped token for the job if a role name is provided. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique job name.' },
        schedule: { type: 'string', description: 'Optional. Cron expression (e.g. "0 8 * * *"). At least one of schedule or trigger_type is required.' },
        trigger_type: { type: 'string', enum: ['new_message', 'keyword', 'unanswered'], description: 'Optional. Trigger condition type.' },
        trigger_config: { type: 'object', description: 'Optional. Config for the trigger (chat_id, label, keywords, hours).' },
        model_config: { type: 'object', description: 'BYOM config: { provider, model, api_key_ref, endpoint? }. provider="anthropic" or "openai".' },
        task_prompt: { type: 'string', description: 'Task prompt for the agent. Supports {chat_name}, {chat_id}, {sender}, {snippet}, {timestamp}, {account_id} variables.' },
        role: { type: 'string', description: 'Role name. A scoped token will be auto-created for this job.' },
        cooldown_secs: { type: 'number', description: 'Minimum seconds between runs (default 3600). Prevents repeated firing on active chats.' },
      },
      required: ['name', 'model_config', 'task_prompt'],
    },
  },
  {
    name: 'list_jobs',
    description: 'List all observer jobs with status, schedule, trigger, last run time, and token label. MASTER_TOKEN required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'toggle_job',
    description: 'Enable or disable an observer job by name. Does not revoke its token. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name.' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable.' },
      },
      required: ['name', 'enabled'],
    },
  },
  {
    name: 'delete_job',
    description: 'Delete an observer job by name. The associated token is NOT automatically revoked — use revoke_token separately if needed. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name to delete.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_job',
    description: 'Update fields on an existing observer job. Only provided fields are changed. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name to update.' },
        task_prompt: { type: 'string' },
        schedule: { type: 'string' },
        trigger_type: { type: 'string' },
        trigger_config: { type: 'object' },
        model_config: { type: 'object' },
        cooldown_secs: { type: 'number' },
      },
      required: ['name'],
    },
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
  ctx: TokenContext,
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
    const res = await handleSearch(req, env, accountId, ctx.role);
    const data = await res.json() as { results?: Array<Record<string, unknown>> };
    if (Array.isArray(data.results)) {
      data.results = data.results.map(truncateText);
    }
    return data;
  }

  if (name === 'chats') {
    const params = new URLSearchParams();
    if (typeof args.name === 'string') params.set('name', args.name);
    if (typeof args.label === 'string') params.set('label', args.label);
    if (typeof args.chat_type === 'string') params.set('chat_type', args.chat_type);
    if (typeof args.filter === 'string') params.set('filter', args.filter);
    if (typeof args.sort_by === 'string') params.set('sort_by', args.sort_by);
    const req = new Request(`${baseUrl}/chats?${params.toString()}`);
    const res = await handleChats(req, env, accountId, ctx.role);
    return await res.json();
  }

  if (name === 'history') {
    // W-11: use ASC ordering with after_ keyset cursors so pages advance forward in time.
    if (typeof args.chat_id !== 'string') throw new Error('chat_id is required');
    const chatId = args.chat_id;
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50);
    const afterSentAt = typeof args.after_sent_at === 'number' ? args.after_sent_at : null;
    const afterId = typeof args.after_id === 'number' ? args.after_id : null;

    const baseBinds: unknown[] = [accountId, chatId]; // $1, $2
    const keysetBinds: unknown[] = afterSentAt !== null && afterId !== null
      ? [afterSentAt, afterId] // $3, $4
      : [];
    const keysetClause = keysetBinds.length > 0
      ? `AND (sent_at > $3 OR (sent_at = $3 AND id > $4))`
      : ``;
    // Scope: accountId is $1; starts after base + keyset binds
    const { clause: scopeClause, binds: scopeBinds } = buildReadScopeClause(
      ctx.role, '', baseBinds.length + keysetBinds.length + 1, 1,
    );
    const limitIdx = baseBinds.length + keysetBinds.length + scopeBinds.length + 1;

    const SQL = `
      SELECT id, tg_message_id, tg_chat_id, chat_name, chat_type,
             sender_id, sender_username, sender_first_name, sender_last_name,
             message_type, text, media_type,
             reply_to_message_id, forwarded_from_name, sent_at
      FROM messages
      WHERE account_id = $1
        AND tg_chat_id = $2
        AND is_deleted = 0
        ${keysetClause}
        ${scopeClause}
      ORDER BY sent_at ASC, id ASC
      LIMIT $${limitIdx}
    `.trim();

    const sql = getSql(env);
    const rows = await sql(SQL, [...baseBinds, ...keysetBinds, ...scopeBinds, limit]);
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
      ? `%${args.search.trim().replace(/[%_\\]/g, '\\$&')}%`
      : null;
    const hasMessages = args.has_messages === true;
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
      HAVING ($3::boolean IS NOT TRUE OR COUNT(m.id) > 0)
      ORDER BY last_seen DESC NULLS LAST
    `.trim();
    const rows = await getSql(env)(SQL, [accountId, search, hasMessages || null]) as Array<{
      tg_user_id: string; phone: string | null; username: string | null;
      first_name: string | null; last_name: string | null;
      is_mutual: number; is_bot: number;
      message_count: string; last_seen: string | null;
    }>;
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
    const res = await handleSearch(req, env, accountId, ctx.role);
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

  if (name === 'digest') {
    const hours = typeof args.hours === 'number' ? Math.min(Math.max(args.hours, 1), 720) : 24;
    const perChat = Math.min(typeof args.per_chat === 'number' ? args.per_chat : 5, 20);
    const labelFilter = typeof args.label === 'string' ? args.label : null;
    const since = Math.floor(Date.now() / 1000) - hours * 3600;

    // Base binds: $1=accountId, $2=since, $3=labelFilter; scope starts at $4; perChat is last
    const { clause: scopeClause, binds: scopeBinds } = buildReadScopeClause(ctx.role, 'm', 4, 1);
    const perChatIdx = 3 + scopeBinds.length + 1;

    const SQL = `
      WITH ranked AS (
        SELECT
          m.tg_chat_id,
          MAX(m.chat_name) OVER (PARTITION BY m.tg_chat_id) AS chat_name,
          MAX(cc.label) OVER (PARTITION BY m.tg_chat_id) AS label,
          m.id, m.tg_message_id, m.sender_username, m.sender_first_name,
          m.text, m.media_type, m.sent_at,
          ROW_NUMBER() OVER (PARTITION BY m.tg_chat_id ORDER BY m.sent_at DESC, m.id DESC) AS rn
        FROM messages m
        LEFT JOIN chat_config cc ON cc.account_id = m.account_id AND cc.tg_chat_id = m.tg_chat_id
        WHERE m.account_id = $1
          AND m.sent_at >= $2
          AND m.is_deleted = 0
          AND ($3::text IS NULL OR cc.label = $3)
          ${scopeClause}
      )
      SELECT tg_chat_id, chat_name, label, id, tg_message_id,
             sender_username, sender_first_name, text, media_type, sent_at
      FROM ranked
      WHERE rn <= $${perChatIdx}
      ORDER BY tg_chat_id, sent_at ASC, id ASC
    `.trim();

    const rows = await getSql(env)(SQL, [accountId, since, labelFilter, ...scopeBinds, perChat]) as Array<Record<string, unknown>>;

    // Group by chat
    const chats: Record<string, { chat_name: unknown; label: unknown; messages: Array<Record<string, unknown>> }> = {};
    for (const row of rows) {
      const cid = row.tg_chat_id as string;
      if (!chats[cid]) chats[cid] = { chat_name: row.chat_name, label: row.label, messages: [] };
      const { tg_chat_id: _c, chat_name: _n, label: _l, ...msg } = row;
      chats[cid].messages.push(truncateText(msg));
    }
    return { hours, per_chat: perChat, chats };
  }

  if (name === 'thread') {
    if (typeof args.chat_id !== 'string') throw new Error('chat_id is required');
    if (typeof args.message_id !== 'string') throw new Error('message_id is required');
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 200);
    const afterId = typeof args.after_id === 'number' ? args.after_id : null;

    // Base: $1=accountId, $2=chatId, $3=messageId; keyset: [$4=afterId] if present
    const baseBinds: unknown[] = [accountId, args.chat_id, args.message_id];
    const keysetBinds: unknown[] = afterId !== null ? [afterId] : [];
    const keysetClause = keysetBinds.length > 0 ? `AND id > $4` : ``;
    // Scope: accountId is $1; starts after base + keyset
    const { clause: scopeClause, binds: scopeBinds } = buildReadScopeClause(
      ctx.role, '', baseBinds.length + keysetBinds.length + 1, 1,
    );
    const limitIdx = baseBinds.length + keysetBinds.length + scopeBinds.length + 1;

    const SQL = `
      SELECT id, tg_message_id, sender_username, sender_first_name,
             text, media_type, reply_to_message_id, sent_at
      FROM messages
      WHERE account_id = $1
        AND tg_chat_id = $2
        AND is_deleted = 0
        AND (
          tg_message_id = $3
          OR tg_message_id = (SELECT reply_to_message_id::text FROM messages WHERE account_id = $1 AND tg_chat_id = $2 AND tg_message_id = $3 LIMIT 1)
          OR reply_to_message_id = $3::bigint
        )
        ${keysetClause}
        ${scopeClause}
      ORDER BY sent_at ASC, id ASC
      LIMIT $${limitIdx}
    `.trim();

    const rows = await getSql(env)(SQL, [...baseBinds, ...keysetBinds, ...scopeBinds, limit]) as Array<Record<string, unknown> & { id: number }>;
    const lastRow = rows.length === limit ? rows[rows.length - 1] : null;
    return {
      chat_id: args.chat_id,
      message_id: args.message_id,
      messages: rows.map(truncateText),
      next_after_id: lastRow?.id ?? null,
    };
  }

  if (name === 'send' || name === 'draft') {
    if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text is required');

    // Write permission check (send only — drafts are not writes until promoted)
    if (name === 'send') {
      const targetChatId = typeof args.tg_chat_id === 'string' ? args.tg_chat_id : null;
      if (targetChatId) {
        const permErr = await checkAndAuditWrite('send', targetChatId, { queued: true }, ctx, accountId, env);
        if (permErr) return permErr;
      } else if (Array.isArray(args.recipients) && ctx.role !== null) {
        // Mass send: check write permission for each recipient individually
        for (const r of args.recipients as Array<Record<string, unknown>>) {
          const recipChatId = typeof r.tg_chat_id === 'string' ? r.tg_chat_id : null;
          if (recipChatId) {
            const permErr = await checkAndAuditWrite('send', recipChatId, { queued: true }, ctx, accountId, env);
            if (permErr) return permErr;
          }
        }
      }
    }

    let requestedStatus: string;
    if (name === 'draft') {
      requestedStatus = 'draft';
    } else if (typeof args.scheduled_at === 'number') {
      requestedStatus = 'scheduled';
    } else {
      requestedStatus = 'pending';
    }
    const req = new Request(`${baseUrl}/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, status: requestedStatus }),
    });
    const res = await handlePostOutbox(req, env, accountId);
    const data = await res.json() as Record<string, unknown>;
    if (res.status !== 200) throw new Error(String(data.error ?? 'Failed to queue message'));
    const note = name === 'draft'
      ? 'Saved as draft. Use POST /outbox/:id/send to queue it for sending.'
      : requestedStatus === 'scheduled'
        ? `Scheduled. GramJS will send it at the specified time.`
        : 'Message queued. GramJS will send it within 30 seconds.';
    return { ...data, note };
  }

  if (name === 'edit_message') {
    {
      const targetChatId = typeof args.tg_chat_id === 'string' ? args.tg_chat_id : null;
      if (targetChatId) {
        const permErr = await checkAndAuditWrite('edit', targetChatId, { msg_id: args.tg_message_id }, ctx, accountId, env);
        if (permErr) return permErr;
      }
    }
    const req = new Request(`${baseUrl}/actions/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const res = await handlePostAction(req, env, accountId, 'edit');
    const data = await res.json() as Record<string, unknown>;
    if (res.status !== 200) throw new Error(String(data.error ?? 'Failed to queue edit'));
    return { ...data, note: 'Edit queued. GramJS will apply it within 30 seconds.' };
  }

  if (name === 'delete_message') {
    {
      const targetChatId = typeof args.tg_chat_id === 'string' ? args.tg_chat_id : null;
      if (targetChatId) {
        const permErr = await checkAndAuditWrite('delete', targetChatId, { msg_id: args.tg_message_id }, ctx, accountId, env);
        if (permErr) return permErr;
      }
    }
    const req = new Request(`${baseUrl}/actions/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const res = await handlePostAction(req, env, accountId, 'delete');
    const data = await res.json() as Record<string, unknown>;
    if (res.status !== 200) throw new Error(String(data.error ?? 'Failed to queue delete'));
    return { ...data, note: 'Delete queued. GramJS will apply it within 30 seconds.' };
  }

  if (name === 'forward_message') {
    {
      // Check that the source chat is within read scope — you can't forward what you can't read
      if (ctx.role && ctx.role.read_mode !== 'all') {
        const sourceChatId = typeof args.tg_chat_id === 'string' ? args.tg_chat_id : null;
        if (sourceChatId) {
          const sqlFn = getSql(env);
          const srcRows = await sqlFn(
            `SELECT MAX(cc.label) AS label FROM messages m
             LEFT JOIN chat_config cc ON cc.account_id = m.account_id AND cc.tg_chat_id = m.tg_chat_id
             WHERE m.account_id = $1 AND m.tg_chat_id = $2`,
            [accountId, sourceChatId],
          ) as Array<{ label: string | null }>;
          const srcLabel = srcRows[0]?.label ?? null;
          const role = ctx.role;
          const denied =
            role.read_mode === 'whitelist'
              ? !(role.read_chat_ids?.includes(sourceChatId) || (srcLabel && role.read_labels?.includes(srcLabel)))
              : role.read_mode === 'blacklist'
              ? (role.read_chat_ids?.includes(sourceChatId) || (srcLabel && role.read_labels?.includes(srcLabel)))
              : false;
          if (denied) {
            return { error: 'permission_denied', message: `This token cannot read from chat ${sourceChatId} (out of read scope).`, action: 'forward' };
          }
        }
      }
      const targetChatId = typeof args.to_chat_id === 'string' ? args.to_chat_id : null;
      if (targetChatId) {
        const permErr = await checkAndAuditWrite('forward', targetChatId, { from_chat: args.tg_chat_id, msg_id: args.tg_message_id }, ctx, accountId, env);
        if (permErr) return permErr;
      }
    }
    const req = new Request(`${baseUrl}/actions/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const res = await handlePostAction(req, env, accountId, 'forward');
    const data = await res.json() as Record<string, unknown>;
    if (res.status !== 200) throw new Error(String(data.error ?? 'Failed to queue forward'));
    return { ...data, note: 'Forward queued. GramJS will apply it within 30 seconds.' };
  }

  if (name === 'outbox_status') {
    if (typeof args.id !== 'number') throw new Error('id is required');
    const sql = getSql(env);
    const rows = await sql(
      `SELECT id, tg_chat_id, text, status, scheduled_at, error, created_at, updated_at, sent_at
       FROM outbox WHERE account_id = $1 AND id = $2`,
      [accountId, args.id],
    ) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new Error(`No outbox item with id ${args.id}`);
    return rows[0];
  }

  // ---------------------------------------------------------------------------
  // whoami — available to all authenticated callers
  // ---------------------------------------------------------------------------

  if (name === 'whoami') {
    if (ctx.token_id === null) {
      return { access: 'MASTER_TOKEN', role: null, note: 'Full access — no restrictions.' };
    }
    return {
      access: 'agent_token',
      token_id: ctx.token_id.toString(),
      role: ctx.role?.name ?? null,
      read_mode: ctx.role?.read_mode ?? null,
      read_labels: ctx.role?.read_labels ?? null,
      read_chat_ids: ctx.role?.read_chat_ids ?? null,
      can_send: !!ctx.role?.can_send,
      can_edit: !!ctx.role?.can_edit,
      can_delete: !!ctx.role?.can_delete,
      can_forward: !!ctx.role?.can_forward,
      write_chat_types: ctx.role?.write_chat_types ?? null,
      write_labels: ctx.role?.write_labels ?? null,
      write_chat_ids: ctx.role?.write_chat_ids ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // MASTER_TOKEN-only tools — role + token management
  // ---------------------------------------------------------------------------

  // Guard applied once here; each tool case below can assume MASTER_TOKEN
  if ([
    'create_role', 'list_roles', 'update_role', 'delete_role',
    'create_token', 'list_tokens', 'revoke_token',
    'create_job', 'list_jobs', 'toggle_job', 'delete_job', 'update_job',
  ].includes(name)) {
    if (ctx.token_id !== null) {
      return { error: 'permission_denied', message: 'MASTER_TOKEN required for permission management tools.' };
    }
    const sql = getSql(env);
    const now = Math.floor(Date.now() / 1000);

    // ---- Roles ----

    if (name === 'create_role') {
      const roleName = args.name;
      if (typeof roleName !== 'string' || !roleName.trim()) throw new Error('name is required');
      const readMode = (args.read_mode as string) ?? 'all';
      if (!['all', 'whitelist', 'blacklist'].includes(readMode)) throw new Error('read_mode must be all, whitelist, or blacklist');
      const readLabels = Array.isArray(args.read_labels) ? args.read_labels as string[] : null;
      const readChatIds = Array.isArray(args.read_chat_ids) ? args.read_chat_ids as string[] : null;

      // Validate: whitelist/blacklist must have at least one filter; empty arrays are invalid
      if (readMode !== 'all') {
        if ((readLabels !== null && readLabels.length === 0) || (readChatIds !== null && readChatIds.length === 0)) {
          throw new Error('read_labels and read_chat_ids must be non-empty arrays when set');
        }
        if (!readLabels?.length && !readChatIds?.length) {
          throw new Error(`read_mode "${readMode}" requires at least one of read_labels or read_chat_ids`);
        }
      }

      const writeChatTypes = Array.isArray(args.write_chat_types) ? args.write_chat_types as string[] : null;
      const writeLabels = Array.isArray(args.write_labels) ? args.write_labels as string[] : null;
      const writeChatIds = Array.isArray(args.write_chat_ids) ? args.write_chat_ids as string[] : null;

      const rows = await sql(
        `INSERT INTO roles (name, read_mode, read_labels, read_chat_ids, can_send, can_edit, can_delete, can_forward, write_chat_types, write_labels, write_chat_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, name, read_mode`,
        [
          roleName.trim(), readMode,
          readLabels ? JSON.stringify(readLabels) : null,
          readChatIds ? JSON.stringify(readChatIds) : null,
          args.can_send ? 1 : 0,
          args.can_edit ? 1 : 0,
          args.can_delete ? 1 : 0,
          args.can_forward ? 1 : 0,
          writeChatTypes ? JSON.stringify(writeChatTypes) : null,
          writeLabels ? JSON.stringify(writeLabels) : null,
          writeChatIds ? JSON.stringify(writeChatIds) : null,
        ],
      ) as Array<{ id: bigint; name: string; read_mode: string }>;
      return { ok: true, role: { id: rows[0].id.toString(), name: rows[0].name, read_mode: rows[0].read_mode } };
    }

    if (name === 'list_roles') {
      const rows = await sql(`
        SELECT r.id, r.name, r.read_mode, r.read_labels, r.read_chat_ids,
               r.can_send, r.can_edit, r.can_delete, r.can_forward,
               r.write_chat_types, r.write_labels, r.write_chat_ids,
               COUNT(tar.token_id) AS token_count
        FROM roles r
        LEFT JOIN token_account_roles tar ON tar.role_id = r.id
        GROUP BY r.id, r.name, r.read_mode, r.read_labels, r.read_chat_ids,
                 r.can_send, r.can_edit, r.can_delete, r.can_forward,
                 r.write_chat_types, r.write_labels, r.write_chat_ids
        ORDER BY r.name
      `) as Array<Record<string, unknown>>;
      return rows.map(r => ({
        id: (r.id as bigint).toString(),
        name: r.name,
        read_mode: r.read_mode,
        read_labels: parseJsonColumn(r.read_labels),
        read_chat_ids: parseJsonColumn(r.read_chat_ids),
        can_send: !!r.can_send, can_edit: !!r.can_edit,
        can_delete: !!r.can_delete, can_forward: !!r.can_forward,
        write_chat_types: parseJsonColumn(r.write_chat_types),
        write_labels: parseJsonColumn(r.write_labels),
        write_chat_ids: parseJsonColumn(r.write_chat_ids),
        token_count: parseInt(r.token_count as string, 10),
      }));
    }

    if (name === 'update_role') {
      if (typeof args.name !== 'string') throw new Error('name is required');
      // Build dynamic SET clause from provided fields
      const updates: string[] = [];
      const binds: unknown[] = [];
      let n = 2; // $1 = name (WHERE clause)

      const fieldMap: Record<string, string> = {
        new_name: 'name', read_mode: 'read_mode',
        can_send: 'can_send', can_edit: 'can_edit', can_delete: 'can_delete', can_forward: 'can_forward',
      };
      for (const [arg, col] of Object.entries(fieldMap)) {
        if (arg in args) {
          if (arg === 'new_name') {
            updates.push(`${col} = $${n}`); binds.push(args[arg]); n++;
          } else if (['can_send','can_edit','can_delete','can_forward'].includes(arg)) {
            updates.push(`${col} = $${n}`); binds.push(args[arg] ? 1 : 0); n++;
          } else {
            updates.push(`${col} = $${n}`); binds.push(args[arg]); n++;
          }
        }
      }
      for (const jsonCol of ['read_labels','read_chat_ids','write_chat_types','write_labels','write_chat_ids']) {
        if (jsonCol in args) {
          const val = args[jsonCol];
          updates.push(`${jsonCol} = $${n}`);
          binds.push(Array.isArray(val) ? JSON.stringify(val) : null);
          n++;
        }
      }
      if (updates.length === 0) throw new Error('No fields to update');
      await sql(`UPDATE roles SET ${updates.join(', ')} WHERE name = $1`, [args.name, ...binds]);
      return { ok: true };
    }

    if (name === 'delete_role') {
      if (typeof args.name !== 'string') throw new Error('name is required');
      // DELETE RESTRICT on token_account_roles — will fail if tokens reference this role
      try {
        const result = await sql(`DELETE FROM roles WHERE name = $1`, [args.name], { fullResults: true }) as { rowCount?: number };
        if ((result.rowCount ?? 0) === 0) throw new Error(`Role "${args.name}" not found`);
      } catch (err) {
        if (err instanceof Error && err.message.includes('violates foreign key')) {
          throw new Error(`Cannot delete role "${args.name}" — tokens still reference it. Revoke those tokens first.`);
        }
        throw err;
      }
      return { ok: true };
    }

    // ---- Tokens ----

    if (name === 'create_token') {
      if (typeof args.role !== 'string') throw new Error('role is required');
      const tokenLabel = typeof args.label === 'string' ? args.label : null;

      // Resolve role_id
      const roleRows = await sql(`SELECT id FROM roles WHERE name = $1`, [args.role]) as Array<{ id: bigint }>;
      if (roleRows.length === 0) throw new Error(`Role "${args.role}" not found`);
      const roleId = roleRows[0].id;

      // Normalize account_ids: accept single string or array
      let accountIds: string[];
      if (typeof args.account_id === 'string') {
        accountIds = [args.account_id];
      } else if (Array.isArray(args.account_ids)) {
        accountIds = args.account_ids as string[];
      } else {
        accountIds = ['primary'];
      }
      if (accountIds.length === 0) throw new Error('account_ids must not be empty');

      // Generate 32 random bytes → 64-char hex raw token
      const rawBytes = new Uint8Array(32);
      crypto.getRandomValues(rawBytes);
      const rawToken = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      const hash = await hashToken(rawToken);

      const expiresAt = typeof args.expires_at === 'number' ? args.expires_at : null;

      // Insert agent_token row
      const tokenRows = await sql(
        `INSERT INTO agent_tokens (token_hash, label, expires_at, created_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [hash, tokenLabel, expiresAt, now],
      ) as Array<{ id: bigint }>;
      const tokenId = tokenRows[0].id;

      // Insert one token_account_roles row per account_id (single-row inserts per codebase convention)
      for (const aid of accountIds) {
        await sql(
          `INSERT INTO token_account_roles (token_id, account_id, role_id) VALUES ($1, $2, $3)`,
          [tokenId, aid, roleId],
        );
      }

      return {
        ok: true,
        token: rawToken,  // returned once — not stored
        token_id: tokenId.toString(),
        label: args.label,
        role: args.role,
        account_ids: accountIds,
        expires_at: toISO(expiresAt),
        note: 'Save this token now — it cannot be retrieved again.',
      };
    }

    if (name === 'list_tokens') {
      const rows = await sql(`
        SELECT at.id, at.label, at.expires_at, at.last_used_at, at.created_at,
               tar.account_id, r.name AS role_name
        FROM agent_tokens at
        JOIN token_account_roles tar ON tar.token_id = at.id
        JOIN roles r ON r.id = tar.role_id
        ORDER BY at.created_at DESC, at.id, tar.account_id
      `) as Array<Record<string, unknown>>;

      // Group by token_id
      const tokens: Record<string, Record<string, unknown>> = {};
      for (const row of rows) {
        const tid = (row.id as bigint).toString();
        if (!tokens[tid]) {
          tokens[tid] = {
            id: tid,
            label: row.label,
            expires_at: toISO(row.expires_at as number | null),
            last_used_at: toISO(row.last_used_at as number | null),
            created_at: toISO(row.created_at as number),
            accounts: [],
          };
        }
        (tokens[tid].accounts as Array<{ account_id: string; role: string }>).push({
          account_id: row.account_id as string,
          role: row.role_name as string,
        });
      }
      return Object.values(tokens);
    }

    if (name === 'revoke_token') {
      if (typeof args.token_id !== 'string') throw new Error('token_id is required');
      const result = await sql(
        `DELETE FROM agent_tokens WHERE id = $1`,
        [BigInt(args.token_id)],
        { fullResults: true },
      ) as { rowCount?: number };
      if ((result.rowCount ?? 0) === 0) throw new Error('Token not found');
      return { ok: true, note: 'Token revoked. Audit log rows are preserved.' };
    }

    // ---- Jobs ----

    if (name === 'create_job') {
      if (typeof args.name !== 'string') throw new Error('name is required');
      if (typeof args.model_config !== 'object' || !args.model_config) throw new Error('model_config is required');
      if (typeof args.task_prompt !== 'string') throw new Error('task_prompt is required');
      if (!args.schedule && !args.trigger_type) throw new Error('At least one of schedule or trigger_type is required');

      const modelConfigStr = JSON.stringify(args.model_config);
      const triggerConfigStr = args.trigger_config ? JSON.stringify(args.trigger_config) : null;
      const cooldownSecs = typeof args.cooldown_secs === 'number' ? args.cooldown_secs : 3600;

      // Auto-create a scoped token if a role name is provided
      let tokenId: bigint | null = null;
      if (typeof args.role === 'string') {
        const roleRows = await sql(`SELECT id FROM roles WHERE name = $1`, [args.role]) as Array<{ id: bigint }>;
        if (roleRows.length === 0) throw new Error(`Role "${args.role}" not found`);
        const rawBytes = new Uint8Array(32);
        crypto.getRandomValues(rawBytes);
        const rawToken = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        const hash = await hashToken(rawToken);
        const tokenRows = await sql(
          `INSERT INTO agent_tokens (token_hash, label, created_at) VALUES ($1, $2, $3) RETURNING id`,
          [hash, `job:${args.name}`, now],
        ) as Array<{ id: bigint }>;
        tokenId = tokenRows[0].id;
        await sql(
          `INSERT INTO token_account_roles (token_id, account_id, role_id) VALUES ($1, $2, $3)`,
          [tokenId, accountId, roleRows[0].id],
        );
      }

      const rows = await sql(
        `INSERT INTO jobs (account_id, name, schedule, trigger_type, trigger_config, model_config, task_prompt, token_id, cooldown_secs, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          accountId, args.name,
          args.schedule ?? null, args.trigger_type ?? null, triggerConfigStr,
          modelConfigStr, args.task_prompt, tokenId, cooldownSecs, now,
        ],
      ) as Array<{ id: bigint }>;
      return { ok: true, job_id: rows[0].id.toString() };
    }

    if (name === 'list_jobs') {
      const rows = await sql(`
        SELECT j.id, j.name, j.enabled, j.schedule, j.trigger_type,
               j.last_run_at, j.cooldown_secs, j.created_at,
               at.label AS token_label
        FROM jobs j
        LEFT JOIN agent_tokens at ON at.id = j.token_id
        WHERE j.account_id = $1
        ORDER BY j.name
      `, [accountId]) as Array<Record<string, unknown>>;
      return rows.map(r => ({
        id: (r.id as bigint).toString(),
        name: r.name, enabled: !!r.enabled,
        schedule: r.schedule ?? null, trigger_type: r.trigger_type ?? null,
        last_run_at: toISO(r.last_run_at as number | null),
        cooldown_secs: r.cooldown_secs,
        created_at: toISO(r.created_at as number),
        token_label: r.token_label ?? null,
      }));
    }

    if (name === 'toggle_job') {
      if (typeof args.name !== 'string') throw new Error('name is required');
      const enabled = args.enabled !== false ? 1 : 0;
      await sql(`UPDATE jobs SET enabled = $1 WHERE account_id = $2 AND name = $3`, [enabled, accountId, args.name]);
      return { ok: true };
    }

    if (name === 'delete_job') {
      if (typeof args.name !== 'string') throw new Error('name is required');
      await sql(`DELETE FROM jobs WHERE account_id = $1 AND name = $2`, [accountId, args.name]);
      return { ok: true };
    }

    if (name === 'update_job') {
      if (typeof args.name !== 'string') throw new Error('name is required');
      const updates: string[] = [];
      const binds: unknown[] = [accountId, args.name];
      let n = 3;
      if ('task_prompt' in args) { updates.push(`task_prompt = $${n}`); binds.push(args.task_prompt); n++; }
      if ('schedule' in args) { updates.push(`schedule = $${n}`); binds.push(args.schedule ?? null); n++; }
      if ('trigger_type' in args) { updates.push(`trigger_type = $${n}`); binds.push(args.trigger_type ?? null); n++; }
      if ('trigger_config' in args) { updates.push(`trigger_config = $${n}`); binds.push(args.trigger_config ? JSON.stringify(args.trigger_config) : null); n++; }
      if ('model_config' in args) { updates.push(`model_config = $${n}`); binds.push(JSON.stringify(args.model_config)); n++; }
      if ('cooldown_secs' in args) { updates.push(`cooldown_secs = $${n}`); binds.push(args.cooldown_secs); n++; }
      if (updates.length === 0) throw new Error('No fields to update');
      await sql(`UPDATE jobs SET ${updates.join(', ')} WHERE account_id = $1 AND name = $2`, binds);
      return { ok: true };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcpMessage(
  msg: Record<string, unknown>,
  env: Env,
  accountId: string,
  ctx: TokenContext,
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
        instructions: `You have full read/write access to a Telegram archive (51k+ messages, 205 chats). All timestamps are Unix epoch seconds.

TOOL SELECTION — pick the right tool first time:
- User asks about a past conversation, event, person, amount, decision → "search" (always start here)
- User wants a morning briefing or catch-up across chats → "digest" (grouped by chat, supports label filter)
- User asks "what's new" or "latest messages" → "digest(hours=1)" not "recent" (digest groups by chat, recent is a flat dump)
- User wants to browse one chat chronologically → "history" (get chat_id from "chats" first)
- User mentions a specific reply chain or wants context around one message → "thread"
- User asks about a person → "contacts" to find username, then "search" with sender_username
- User asks about archive size or date range → "stats"

SEARCH TIPS:
- Multiple words are ANDed — use words likely to appear verbatim
- Always set from/to when the user mentions a time period (ISO 8601 or Unix epoch)
- Paginate with next_before_id + next_before_sent_at from previous response
- If 0 results: try fewer/broader terms, remove date range, check spelling

HISTORY / THREAD PAGINATION:
- history: next_after_id + next_after_sent_at (advances forward in time)
- thread: next_after_id (advances through replies)

WRITE TOOLS (GramJS executes within 30 seconds):
- "send" — single chat or mass send with {first_name}/{last_name}/{username} placeholders
- "draft" — save without sending; returns outbox id to review or promote later
- "edit_message" / "delete_message" / "forward_message" — queue actions on already-sent messages
- Always confirm before sending or deleting unless the user explicitly said to proceed

AGENTIC WORKFLOWS:
"Find today's action items":
  1. digest(hours=24, label="work") — scan recent work chats
  2. search(query="need action deadline", from=<today>) — surface task language
  3. draft() a summary or send() a reminder if needed

"Catch up on a person":
  1. contacts(search="name") — find their username
  2. search(query="", sender_username="their_username") — all their messages
  3. digest to see recent context in shared chats

"Prepare a mass send":
  1. contacts() — get recipient list
  2. draft(text="Hi {first_name}...", recipients=[...]) — save draft
  3. Review, then POST /outbox/:id/send to promote

IMPORTANT: The archive is complete — never say data is unavailable. Try broader search terms or a wider date range before giving up.`,
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
      const data = await dispatchMcpTool(toolName, toolArgs, env, accountId, ctx);
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

async function handleMcp(request: Request, env: Env, accountId: string, ctx: TokenContext): Promise<Response> {
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
      body.map((msg) => handleMcpMessage(msg as Record<string, unknown>, env, accountId, ctx)),
    );
    // W-10: omit null entries (notifications) from batch response per JSON-RPC 2.0
    const responses = all.filter((r): r is object => r !== null);
    if (responses.length === 0) return new Response(null, { status: 204 });
    return mcpJson(responses);
  }

  // Single message
  if (typeof body === 'object' && body !== null) {
    const response = await handleMcpMessage(body as Record<string, unknown>, env, accountId, ctx);
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
    return handleGetConfig(request, env, accountId);
  }

  if (method === 'POST' && pathname === '/config') {
    return handlePostConfig(request, env, accountId);
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


  // Outbox
  if (method === 'POST' && pathname === '/outbox') {
    return handlePostOutbox(request, env, accountId);
  }
  if (method === 'GET' && pathname === '/outbox') {
    return handleGetOutbox(request, env, accountId);
  }
  if (method === 'GET' && pathname === '/outbox/due') {
    return handleGetOutboxDue(request, env, accountId);
  }
  const outboxItemMatch = pathname.match(/^\/outbox\/(\d+)$/);
  if (outboxItemMatch) {
    const outboxId = parseInt(outboxItemMatch[1], 10);
    if (method === 'PATCH') return handlePatchOutbox(outboxId, request, env, accountId);
    if (method === 'DELETE') return handleDeleteOutbox(outboxId, env, accountId);
  }
  const outboxSendMatch = pathname.match(/^\/outbox\/(\d+)\/send$/);
  if (method === 'POST' && outboxSendMatch) {
    return handleSendOutbox(parseInt(outboxSendMatch[1], 10), request, env, accountId);
  }
  const outboxAckMatch = pathname.match(/^\/outbox\/(\d+)\/ack$/);
  if (method === 'POST' && outboxAckMatch) {
    return handleAckOutbox(parseInt(outboxAckMatch[1], 10), request, env, accountId);
  }

  // Pending actions
  if (method === 'POST' && pathname === '/actions/edit') {
    return handlePostAction(request, env, accountId, 'edit');
  }
  if (method === 'POST' && pathname === '/actions/delete') {
    return handlePostAction(request, env, accountId, 'delete');
  }
  if (method === 'POST' && pathname === '/actions/forward') {
    return handlePostAction(request, env, accountId, 'forward');
  }
  if (method === 'GET' && pathname === '/actions/pending') {
    return handleGetActionsPending(request, env, accountId);
  }
  const actionAckMatch = pathname.match(/^\/actions\/(\d+)\/ack$/);
  if (method === 'POST' && actionAckMatch) {
    return handleAckAction(parseInt(actionAckMatch[1], 10), request, env, accountId);
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

// W-2: account ID must be a non-empty alphanumeric slug (letters, digits, hyphens, underscores).
function isValidAccountId(id: string): boolean {
  return /^[\w-]{1,64}$/.test(id);
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

  // W-2: account ID from header; query-string fallback for /mcp connector URLs only
  let accountId = request.headers.get('X-Account-ID') ?? accountIdOverride ?? 'primary';
  if (!isValidAccountId(accountId)) {
    return json({ ok: false, error: 'Invalid X-Account-ID' }, 400);
  }

  // If account_id is non-numeric (e.g. "d4d0ch"), resolve to numeric_id via contacts self-entry
  if (!/^\d+$/.test(accountId) && accountId !== 'primary') {
    const sql = getSql(env);
    try {
      const rows = await sql(
        `SELECT account_id FROM contacts WHERE username = $1 AND account_id = tg_user_id LIMIT 1`,
        [accountId.toLowerCase()],
      ) as Array<{ account_id: string }>;
      if (rows.length > 0) accountId = rows[0].account_id;
    } catch {
      // Non-fatal — proceed with original value
    }
  }

  if (isMcp) {
    // MCP endpoint: supports MASTER_TOKEN (full access) and scoped agent tokens (RBAC)
    const authResult = await authenticateMcp(request, env, tokenOverride, accountId);
    if ('error' in authResult) {
      // W-15: add CORS headers to auth errors on /mcp so browser callers see a readable 401
      const errRes = authResult.error;
      return new Response(errRes.body, {
        status: errRes.status,
        headers: { ...Object.fromEntries(errRes.headers.entries()), ...CORS_HEADERS },
      });
    }
    return handleMcp(request, env, accountId, authResult.ctx);
  }

  // Non-MCP endpoints: INGEST_TOKEN only
  const authError = await authenticate(request, env);
  if (authError) return authError;

  return route(request, env, accountId);
}

// ---------------------------------------------------------------------------
// Scheduled handler (cron backup)
// ---------------------------------------------------------------------------

async function* streamMessages(sql: NeonQueryFunction<false, false>): AsyncGenerator<string> {
  // W-12: use keyset pagination (WHERE id > lastId) instead of OFFSET.
  const batchSize = 1000;
  let lastId = 0;
  while (true) {
    const rows = await sql(
      `SELECT id, account_id, tg_message_id, tg_chat_id, chat_name, chat_type,
              sender_id, sender_username, sender_first_name, sender_last_name,
              message_type, text, media_type, media_file_id,
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
  const sql = getSql(env);

  try {
    const encoder = new TextEncoder();
    let rowCount = 0;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const line of streamMessages(sql)) {
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

    // Delete R2 backup objects older than 30 days.
    // Keys are backup-YYYY-MM-DD.ndjson — lexicographic order == date order.
    const cutoffKey = `backup-${new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10)}.ndjson`;
    const listed = await env.BACKUP_BUCKET.list({ prefix: 'backup-' });
    const toDelete = listed.objects.filter(o => o.key < cutoffKey).map(o => o.key);
    for (const oldKey of toDelete) {
      await env.BACKUP_BUCKET.delete(oldKey);
      console.log(`[backup] deleted old backup key=${oldKey}`);
    }

    // Prune old audit_log rows per configured retention policy
    const now = Math.floor(Date.now() / 1000);
    const retentionRows = await sql(
      `SELECT value FROM global_config WHERE account_id = 'global' AND key = 'audit_log_retention_days'`,
    ) as Array<{ value: string }>;
    const days = parseInt(retentionRows[0]?.value ?? '90', 10);
    if (days > 0) {
      await sql(`DELETE FROM audit_log WHERE created_at < $1`, [now - days * 86400]);
      console.log(`[backup] pruned audit_log older than ${days} days`);
    }
  } catch (err) {
    console.error('[backup] failed', err);
  }
}

async function runStorageCheck(env: Env): Promise<void> {
  const sql = getSql(env);
  try {
    const rows = await sql(
      `SELECT COUNT(*) AS total_messages, SUM(LENGTH(COALESCE(text, ''))) AS text_bytes FROM messages`,
    ) as Array<{ total_messages: string; text_bytes: string }>;

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

// ---------------------------------------------------------------------------
// Observer jobs — AI agent cron runner (BYOM)
// ---------------------------------------------------------------------------

interface JobRow {
  id: bigint;
  account_id: string;
  name: string;
  schedule: string | null;
  trigger_type: string | null;
  trigger_config: string | null;
  model_config: string;
  task_prompt: string;
  token_id: bigint | null;
  last_run_at: number | null;
  cooldown_secs: number;
  role: RoleRow | null;
}

// Internal agent message format — provider-agnostic.
// Converted to the provider wire format inside callModel.
interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;   // tool result messages: the corresponding call ID
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; // assistant turns
}

interface ModelResponse {
  stop_reason: 'end_turn' | 'tool_use';
  content: string;
  tool_calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

async function getDueJobs(env: Env, now: number): Promise<JobRow[]> {
  const sql = getSql(env);
  const rows = await sql(`
    SELECT j.id, j.account_id, j.name, j.schedule, j.trigger_type, j.trigger_config,
           j.model_config, j.task_prompt, j.token_id, j.last_run_at, j.cooldown_secs,
           r.id              AS role_id,
           r.name            AS role_name,
           r.read_mode,
           r.read_labels,    r.read_chat_ids,
           r.can_send,       r.can_edit,  r.can_delete,  r.can_forward,
           r.write_chat_types, r.write_labels, r.write_chat_ids
    FROM jobs j
    LEFT JOIN token_account_roles tar
           ON tar.token_id = j.token_id AND tar.account_id = j.account_id
    LEFT JOIN roles r ON r.id = tar.role_id
    WHERE j.enabled = 1
      AND j.token_id IS NOT NULL
      AND (j.last_run_at IS NULL OR j.last_run_at < $1 - j.cooldown_secs)
  `, [now]) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    id: row.id as bigint,
    account_id: row.account_id as string,
    name: row.name as string,
    schedule: (row.schedule as string | null) ?? null,
    trigger_type: (row.trigger_type as string | null) ?? null,
    trigger_config: (row.trigger_config as string | null) ?? null,
    model_config: row.model_config as string,
    task_prompt: row.task_prompt as string,
    token_id: row.token_id as bigint | null,
    last_run_at: (row.last_run_at as number | null) ?? null,
    cooldown_secs: row.cooldown_secs as number,
    role: row.role_id ? {
      id: row.role_id as bigint,
      name: row.role_name as string,
      read_mode: row.read_mode as RoleRow['read_mode'],
      read_labels: parseJsonColumn(row.read_labels),
      read_chat_ids: parseJsonColumn(row.read_chat_ids),
      can_send: row.can_send as number,
      can_edit: row.can_edit as number,
      can_delete: row.can_delete as number,
      can_forward: row.can_forward as number,
      write_chat_types: parseJsonColumn(row.write_chat_types),
      write_labels: parseJsonColumn(row.write_labels),
      write_chat_ids: parseJsonColumn(row.write_chat_ids),
    } : null,
  }));
}

async function buildContext(job: JobRow, env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let prompt = job.task_prompt
    .replace(/\{account_id\}/g, job.account_id)
    .replace(/\{timestamp\}/g, new Date(now * 1000).toISOString());

  if (!job.trigger_type) {
    // Schedule-only job: clear the message-context variables and return
    return prompt
      .replace(/\{chat_name\}/g, '')
      .replace(/\{chat_id\}/g, '')
      .replace(/\{sender\}/g, '')
      .replace(/\{snippet\}/g, '');
  }

  // Trigger-based: find the most recent triggering message
  let triggerConfig: Record<string, unknown> = {};
  try {
    if (job.trigger_config) triggerConfig = JSON.parse(job.trigger_config) as Record<string, unknown>;
  } catch { /* use empty config */ }

  const sql = getSql(env);
  const since = job.last_run_at ?? now - 3600;
  const binds: unknown[] = [job.account_id, since];
  let n = 3;
  let extraWhere = '';

  if (typeof triggerConfig.chat_id === 'string') {
    extraWhere += ` AND m.tg_chat_id = $${n}`;
    binds.push(triggerConfig.chat_id);
    n++;
  }
  if (typeof triggerConfig.label === 'string') {
    extraWhere += ` AND EXISTS (
      SELECT 1 FROM chat_config cc
      WHERE cc.account_id = m.account_id AND cc.tg_chat_id = m.tg_chat_id AND cc.label = $${n}
    )`;
    binds.push(triggerConfig.label);
    n++;
  }
  if (job.trigger_type === 'keyword' && Array.isArray(triggerConfig.keywords)) {
    const kws = (triggerConfig.keywords as unknown[])
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map(k => k.trim())
      .join(' & ');
    if (kws) {
      extraWhere += ` AND m.search_vector @@ to_tsquery('simple', $${n})`;
      binds.push(kws);
      n++;
    }
  }

  let trigMsg: Record<string, unknown> | null = null;
  try {
    const rows = await sql(
      `SELECT m.tg_chat_id, m.chat_name, m.sender_username, m.sender_first_name, m.text, m.sent_at
       FROM messages m
       WHERE m.account_id = $1 AND m.sent_at > $2${extraWhere}
       ORDER BY m.sent_at DESC LIMIT 1`,
      binds,
    ) as Array<Record<string, unknown>>;
    trigMsg = rows[0] ?? null;
  } catch { /* proceed without trigger context */ }

  return prompt
    .replace(/\{chat_name\}/g, (trigMsg?.chat_name as string | undefined) ?? '')
    .replace(/\{chat_id\}/g, (trigMsg?.tg_chat_id as string | undefined) ?? '')
    .replace(/\{sender\}/g,
      (trigMsg?.sender_username as string | undefined) ??
      (trigMsg?.sender_first_name as string | undefined) ?? '')
    .replace(/\{snippet\}/g, typeof trigMsg?.text === 'string' ? trigMsg.text.slice(0, 300) : '');
}

async function markJobRun(jobId: bigint, now: number, env: Env): Promise<void> {
  await getSql(env)(`UPDATE jobs SET last_run_at = $1 WHERE id = $2`, [now, jobId]);
}

// Wrapper for outbound HTTP requests from callModel — Cloudflare Workers supports
// string URLs in fetch() at runtime but the type declaration requires RequestInfo.
// Using (globalThis.fetch as ...) sidesteps the union resolution issue cleanly.
const httpFetch: (url: string, init: RequestInit) => Promise<Response> =
  globalThis.fetch.bind(globalThis) as unknown as (url: string, init: RequestInit) => Promise<Response>;

// Convert internal AgentMessage array → Anthropic API messages.
// Anthropic requires strict user/assistant alternation; tool results are
// grouped into a user message with tool_result content blocks.
function toAnthropicMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content ?? '' });
      i++;
    } else if (msg.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: 'assistant', content: content.length > 0 ? content : '' });
      i++;
      // Collect consecutive tool result messages → one user message
      const toolResults: Array<Record<string, unknown>> = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const tm = messages[i];
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tm.tool_call_id ?? '',
          content: tm.content ?? '',
        });
        i++;
      }
      if (toolResults.length > 0) {
        out.push({ role: 'user', content: toolResults });
      }
    } else {
      // Lone tool message without preceding assistant — skip (shouldn't happen)
      i++;
    }
  }
  return out;
}

// Convert internal AgentMessage array → OpenAI chat completions messages.
function toOpenAIMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map(msg => {
    if (msg.role === 'tool') {
      return { role: 'tool', tool_call_id: msg.tool_call_id ?? '', content: msg.content ?? '' };
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      return {
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    return { role: msg.role, content: msg.content ?? '' };
  });
}

async function callModel(
  modelConfig: Record<string, unknown>,
  messages: AgentMessage[],
  tools: Array<{ name: string; description: string; inputSchema: unknown }>,
  env: Env,
): Promise<ModelResponse> {
  const provider = typeof modelConfig.provider === 'string' ? modelConfig.provider : 'openai';
  const model = typeof modelConfig.model === 'string' ? modelConfig.model : 'gpt-4o';
  const apiKeyRef = typeof modelConfig.api_key_ref === 'string' ? modelConfig.api_key_ref : null;
  const apiKey = apiKeyRef ? ((env as unknown as Record<string, string>)[apiKeyRef] ?? '') : '';

  if (provider === 'anthropic') {
    const endpoint = typeof modelConfig.endpoint === 'string'
      ? modelConfig.endpoint
      : 'https://api.anthropic.com/v1/messages';

    const res = await httpFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: toAnthropicMessages(messages),
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);

    const body = await res.json() as Record<string, unknown>;
    const stopReason = (body.stop_reason as string) ?? 'end_turn';
    const contentArr = (body.content as Array<Record<string, unknown>>) ?? [];
    const textBlock = contentArr.find(c => c.type === 'text');
    const toolBlocks = contentArr.filter(c => c.type === 'tool_use');
    return {
      stop_reason: stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
      content: typeof textBlock?.text === 'string' ? textBlock.text : '',
      tool_calls: toolBlocks.map(b => ({
        id: b.id as string,
        name: b.name as string,
        args: (b.input ?? {}) as Record<string, unknown>,
      })),
    };
  }

  // OpenAI-compatible format (default)
  const endpoint = typeof modelConfig.endpoint === 'string'
    ? modelConfig.endpoint
    : 'https://api.openai.com/v1/chat/completions';

  const res = await httpFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(messages),
      tools: tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: 'auto',
    }),
  });
  if (!res.ok) throw new Error(`Model API error: ${res.status} ${await res.text()}`);

  const body = await res.json() as Record<string, unknown>;
  const choice = ((body.choices as Array<Record<string, unknown>>) ?? [])[0];
  const finishReason = (choice?.finish_reason as string) ?? 'stop';
  const assistantMsg = (choice?.message as Record<string, unknown>) ?? {};
  const rawToolCalls = (assistantMsg.tool_calls as Array<Record<string, unknown>>) ?? [];

  return {
    stop_reason: finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
    content: typeof assistantMsg.content === 'string' ? assistantMsg.content : '',
    tool_calls: rawToolCalls.map(tc => {
      const fn = (tc.function as Record<string, unknown>) ?? {};
      let args: Record<string, unknown> = {};
      try { args = JSON.parse((fn.arguments as string) ?? '{}') as Record<string, unknown>; } catch { /* empty */ }
      return { id: tc.id as string, name: fn.name as string, args };
    }),
  };
}

async function runAgentLoop(job: JobRow, context: string, env: Env): Promise<void> {
  const ctx: TokenContext = { token_id: job.token_id, role: job.role };
  const messages: AgentMessage[] = [{ role: 'user', content: context }];
  let modelConfig: Record<string, unknown> = {};
  try { modelConfig = JSON.parse(job.model_config) as Record<string, unknown>; } catch { /* use defaults */ }

  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let response: ModelResponse;
    try {
      response = await callModel(
        modelConfig,
        messages,
        MCP_TOOL_DEFINITIONS as Array<{ name: string; description: string; inputSchema: unknown }>,
        env,
      );
    } catch (err) {
      console.error(`[jobs] model call failed for job "${job.name}":`, err);
      return;
    }

    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.tool_calls.length > 0 ? response.tool_calls : undefined,
    });

    // Drive the loop from actual tool calls, not stop_reason — more robust across
    // providers and handles edge cases like Anthropic returning max_tokens with
    // complete tool_use blocks already in the content array.
    if (response.tool_calls.length === 0) break;

    for (const tc of response.tool_calls) {
      let result: unknown;
      try {
        result = await dispatchMcpTool(tc.name, tc.args, env, job.account_id, ctx);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
}

async function runJobs(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let dueJobs: JobRow[];
  try {
    dueJobs = await getDueJobs(env, now);
  } catch (err) {
    console.error('[jobs] failed to fetch due jobs:', err);
    return;
  }

  for (const job of dueJobs) {
    try {
      const context = await buildContext(job, env);
      await runAgentLoop(job, context, env);
      await markJobRun(job.id, now, env);
    } catch (err) {
      console.error(`[jobs] job "${job.name}" failed:`, err);
      // Continue — one failure must not block others
    }
  }
}

// W-13: match all cron expressions explicitly to avoid accidental runs
const CRON_DAILY_BACKUP        = '0 3 * * *';   // matches wrangler.toml
const CRON_MONTHLY_STORAGE_CHK = '0 4 1 * *';   // matches wrangler.toml
const CRON_JOB_RUNNER          = '*/15 * * * *'; // matches wrangler.toml

async function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (event.cron === CRON_DAILY_BACKUP) {
    await runBackup(env);
  } else if (event.cron === CRON_MONTHLY_STORAGE_CHK) {
    await runStorageCheck(env);
  } else if (event.cron === CRON_JOB_RUNNER) {
    ctx.waitUntil(runJobs(env));
  } else {
    console.error(`[scheduled] unknown cron expression: ${event.cron} — no action taken`);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default { fetch, scheduled };
