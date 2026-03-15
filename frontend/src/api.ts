// API client — wraps all Worker endpoints

export interface AuthConfig {
  workerUrl: string;
  token: string;
  accountId: string;
}

let _cfg: AuthConfig | null = null;

export function setAuth(cfg: AuthConfig) {
  _cfg = cfg;
  localStorage.setItem('tgr_auth', JSON.stringify(cfg));
}

export function getAuth(): AuthConfig | null {
  if (_cfg) return _cfg;
  const stored = localStorage.getItem('tgr_auth');
  if (stored) { _cfg = JSON.parse(stored); return _cfg; }
  return null;
}

export function clearAuth() {
  _cfg = null;
  localStorage.removeItem('tgr_auth');
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
  date_range: { oldest: string; newest: string };
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
  sender_name: string | null;
  text: string;
  sent_at: number;
}

export interface SearchResult {
  messages: Message[];
  total: number;
  next_cursor: string | null;
}

export function fetchMessages(params: {
  q?: string;
  chat_id?: string;
  chat_type?: string;
  limit?: number;
  cursor?: string;
}) {
  const p = new URLSearchParams();
  if (params.q) p.set('q', params.q);
  if (params.chat_id) p.set('chat_id', params.chat_id);
  if (params.chat_type) p.set('chat_type', params.chat_type);
  p.set('limit', String(params.limit ?? 50));
  if (params.cursor) p.set('cursor', params.cursor);
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

export const fetchChats = (limit = 200) =>
  req<{ chats: Chat[] }>(`/chats?limit=${limit}`);

// ── Contacts ───────────────────────────────────────────────────────────────
export interface Contact {
  tg_user_id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  is_bot: boolean;
}

export const fetchContacts = (limit = 200) =>
  req<{ contacts: Contact[] }>(`/contacts?limit=${limit}`);

// ── Backfill ───────────────────────────────────────────────────────────────
export interface BackfillJob {
  tg_chat_id: string;
  chat_name: string;
  total_messages: number;
  fetched_messages: number;
  status: 'pending' | 'in_progress' | 'done' | 'error';
}

export const fetchBackfill = () =>
  req<{ jobs: BackfillJob[] }>('/backfill/pending');

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
