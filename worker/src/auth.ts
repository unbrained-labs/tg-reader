import type { Env, RoleRow, TokenContext } from './types';
import { json, hashToken, getSql, parseJsonColumn } from './helpers';

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

// W-3: constant-time token comparison to prevent timing side-channel attacks.
// Signs both strings with HMAC-SHA256 using a fresh ephemeral key, then XORs
// the fixed-length digests — the loop always runs the same number of iterations.
export async function timingSafeTokenEqual(provided: string, expected: string): Promise<boolean> {
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
export async function authenticate(request: Request, env: Env, tokenOverride?: string | null): Promise<Response | null> {
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
export async function authenticateMcp(
  request: Request,
  env: Env,
  tokenOverride: string | null,
  accountId: string,
): Promise<{ ctx: TokenContext } | { error: Response }> {
  // Prefer Authorization: Bearer header; fall back to ?token= query param
  const authHeader = request.headers.get('Authorization');
  const raw = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? tokenOverride ?? null;
  if (!raw) return { error: json({ ok: false, error: 'Unauthorized' }, 401) };

  // Log one-off deprecation warning when the token arrived via URL query param.
  // Keep it metadata-only — never log the token itself.
  if (!authHeader && tokenOverride) {
    console.warn('[auth] /mcp token via ?token= query param; prefer Authorization: Bearer header');
  }

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
