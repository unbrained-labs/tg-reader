import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import type { Env, RoleRow } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Token, X-Account-ID, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    },
  });
}

export function getSql(env: Env): NeonQueryFunction<false, false> {
  return neon(env.DATABASE_URL);
}

// ISO 8601 from Unix epoch seconds — used in MCP tool outputs for human-readable timestamps.
export function toISO(unix: number | null): string | null {
  return unix !== null ? new Date(unix * 1000).toISOString() : null;
}

// SHA-256 hex digest of a string — used for agent token hashing.
export async function hashToken(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Safely parse a nullable TEXT JSON column that should be a string array.
export function parseJsonColumn(val: unknown): string[] | null {
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
export function buildReadScopeClause(
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
