// API client — wraps all Worker endpoints

export interface AuthConfig {
  workerUrl: string;
  token: string;
  accountId: string;
}

let _cfg: AuthConfig | null = null;

export function setAuth(cfg: AuthConfig) {
  _cfg = cfg;
  // sessionStorage: gone on tab close, not persisted to disk
  sessionStorage.setItem('tgr_auth', JSON.stringify(cfg));
}

export function getAuth(): AuthConfig | null {
  if (_cfg) return _cfg;
  const stored = sessionStorage.getItem('tgr_auth');
  if (stored) { _cfg = JSON.parse(stored); return _cfg; }
  return null;
}

export function clearAuth() {
  _cfg = null;
  sessionStorage.removeItem('tgr_auth');
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const cfg = getAuth();
  if (!cfg) throw new Error('not authenticated');
  const url = `${cfg.workerUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Token': cfg.token,
      'X-Account-ID': cfg.accountId,
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Stats ──────────────────────────────────────────────────────────────────
export interface Stats {
  total_messages: number;
  total_chats: number;
  total_contacts: number;
  earliest_message_at: number | null;  // unix epoch seconds
  latest_message_at: number | null;    // unix epoch seconds
}

export const fetchStats = () => req<Stats>('/stats');

// ── Search ─────────────────────────────────────────────────────────────────
export interface Message {
  id: number;
  tg_message_id: string;
  tg_chat_id: string;
  chat_name: string;
  chat_type: string;
  sender_id: string;
  sender_username: string | null;
  sender_first_name: string | null;
  sender_last_name: string | null;
  text: string;
  sent_at: number;
}

export interface SearchResult {
  results: Message[];
  total: number;
  next_before_id: number | null;
  next_before_sent_at: number | null;
}

export function fetchMessages(params: {
  q?: string;
  chat_id?: string;
  chat_type?: string;
  limit?: number;
  next_before_id?: number;
  next_before_sent_at?: number;
}) {
  const p = new URLSearchParams();
  if (params.q) p.set('q', params.q);
  if (params.chat_id) p.set('chat_id', params.chat_id);
  if (params.chat_type) p.set('chat_type', params.chat_type);
  p.set('limit', String(params.limit ?? 50));
  if (params.next_before_id) p.set('next_before_id', String(params.next_before_id));
  if (params.next_before_sent_at) p.set('next_before_sent_at', String(params.next_before_sent_at));
  return req<SearchResult>(`/search?${p}`);
}

// ── Chats ──────────────────────────────────────────────────────────────────
export interface Chat {
  tg_chat_id: string;
  chat_name: string;
  chat_type: string;
  message_count: number;
  last_message_at: number | null;
}

export const PAGE_SIZE = 50;

export function fetchChats(params: { limit?: number; offset?: number; name?: string } = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(params.limit ?? PAGE_SIZE));
  if (params.offset) p.set('offset', String(params.offset));
  if (params.name) p.set('name', params.name);
  return req<Chat[]>(`/chats?${p}`);
}

// ── Contacts ───────────────────────────────────────────────────────────────
export interface Contact {
  tg_user_id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  is_bot: number;  // SMALLINT 0|1
}

export function fetchContacts(params: { limit?: number; offset?: number; search?: string } = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(params.limit ?? PAGE_SIZE));
  if (params.offset) p.set('offset', String(params.offset));
  if (params.search) p.set('search', params.search);
  return req<Contact[]>(`/contacts?${p}`);
}

// ── Backfill ───────────────────────────────────────────────────────────────
export interface BackfillJob {
  tg_chat_id: string;
  chat_name: string;
  total_messages: number;
  fetched_messages: number;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
}

export const fetchBackfill = () =>
  req<BackfillJob[]>('/backfill/pending?all=1');

// ── Auth probe ─────────────────────────────────────────────────────────────
export async function probeAuth(cfg: AuthConfig): Promise<void> {
  const url = `${cfg.workerUrl.replace(/\/$/, '')}/stats`;
  const res = await fetch(url, {
    headers: {
      'X-Ingest-Token': cfg.token,
      'X-Account-ID': cfg.accountId,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
}
