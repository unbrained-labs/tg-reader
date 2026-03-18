import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import {
  getAuth, setAuth, clearAuth, probeAuth,
  fetchStats, fetchMessages, fetchChats, fetchContacts, fetchBackfill,
  fetchJobs, toggleJob, createJob, fetchChatsConfig, fetchGlobalConfig, setGlobalConfig,
  updateChatConfig,
  fetchHistory, fetchAuditLog,
  fetchTokens, revokeToken, createToken, fetchRoles,
  PAGE_SIZE,
  type AuthConfig, type Stats, type Message, type Chat, type Contact, type BackfillJob,
  type Job, type ChatConfig, type GlobalConfig, type HistoryResult, type AuditEntry, type CreateJobPayload,
  type AgentToken, type Role, type CreateTokenPayload, type TokenAccount,
} from './api'

// ── Icons (inline SVG, zero dependency) ────────────────────────────────────
const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const icons = {
  overview:   'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 3h7m-3.5-3.5v7',
  search:     'M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z',
  chats:      'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  contacts:   'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 4v6m3-3h-6',
  automation: 'M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm0 6v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  config:     'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  tokens:     'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  logout:     'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v1',
}

type Screen = 'overview' | 'search' | 'chats' | 'contacts' | 'automation' | 'config' | 'tokens'

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmtNum(n: number) {
  return n.toLocaleString()
}

function fmtTs(ts: number) {
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function chatTypeBadge(t: string) {
  const map: Record<string, string> = {
    group: 'badge-neutral',
    supergroup: 'badge-neutral',
    channel: 'badge-accent',
    private: 'badge-success',
    bot: 'badge-warning',
  }
  return map[t] ?? 'badge-neutral'
}

// ── Login ───────────────────────────────────────────────────────────────────
function Login({ onAuth }: { onAuth: () => void }) {
  const [workerUrl, setWorkerUrl] = useState('')
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('primary')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: Event) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const cfg: AuthConfig = { workerUrl: workerUrl.trim(), token: token.trim(), accountId: accountId.trim() || 'primary' }
    try {
      await probeAuth(cfg)
      setAuth(cfg)
      onAuth()
    } catch (err: any) {
      setError(err.message ?? 'Connection failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="login-wrap">
      <div class="login-left">
        <form class="login-form" onSubmit={submit}>
          <div>
            <div class="login-logo">TG_READER</div>
            <div class="login-title">// Sign In</div>
            <div class="login-subtitle">Connect to your Worker instance</div>
          </div>
          <div class="form-group">
            <label class="form-label">Worker URL</label>
            <input class="form-input" type="url" placeholder="https://tg-reader.workers.dev"
              value={workerUrl} onInput={(e: any) => setWorkerUrl(e.target.value)} required />
          </div>
          <div class="form-group">
            <label class="form-label">Ingest Token</label>
            <input class="form-input" type="password" placeholder="your-secret-token"
              value={token} onInput={(e: any) => setToken(e.target.value)} required />
          </div>
          <div class="form-group">
            <label class="form-label">Account ID <span style="opacity:.5">(optional)</span></label>
            <input class="form-input" type="text" placeholder="primary"
              value={accountId} onInput={(e: any) => setAccountId(e.target.value)} />
          </div>
          {error && <div class="form-error">&gt; {error}</div>}
          <button class="btn btn-primary" type="submit" disabled={loading} style="width:100%;justify-content:center">
            {loading ? <span class="spinner" /> : '// Connect'}
          </button>
        </form>
      </div>
      <div class="login-right">
        <div>
          <div class="login-brand">TG_READER</div>
          <div class="login-brand-sub">
            Archive, search and manage your Telegram messages with a self-hosted Cloudflare Worker backend.
          </div>
        </div>
        <div class="login-features">
          {[
            'Full-text search across all messages',
            'Multi-account support via X-Account-ID',
            'Automated backfill with flood protection',
            'Outbox for scheduled message delivery',
            'R2-backed daily backups',
          ].map(f => <div class="login-feature-item">{f}</div>)}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ─────────────────────────────────────────────────────────────────
function Sidebar({ screen, onNav, onLogout, accountId }: {
  screen: Screen
  onNav: (s: Screen) => void
  onLogout: () => void
  accountId: string
}) {
  const navItems: Array<{ id: Screen; label: string; icon: keyof typeof icons }> = [
    { id: 'overview',   label: '// overview',   icon: 'overview' },
    { id: 'search',     label: '// search',     icon: 'search' },
    { id: 'chats',      label: '// chats',      icon: 'chats' },
    { id: 'contacts',   label: '// contacts',   icon: 'contacts' },
    { id: 'automation', label: '// automation', icon: 'automation' },
    { id: 'tokens',     label: '// tokens',     icon: 'tokens' },
    { id: 'config',     label: '// config',     icon: 'config' },
  ]

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-logo">TG_READER</span>
      </div>
      <nav class="sidebar-nav">
        {navItems.map(item => (
          <button
            key={item.id}
            class={`nav-item${screen === item.id ? ' active' : ''}`}
            onClick={() => onNav(item.id)}
          >
            <Icon d={icons[item.icon]} />
            {item.label}
          </button>
        ))}
      </nav>
      <div class="sidebar-bottom">
        <Icon d={icons.logout} size={14} />
        <span class="sidebar-account" style="flex:1" title={accountId}>{accountId}</span>
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onClick={onLogout}>
          out
        </button>
      </div>
    </aside>
  )
}

// ── PageHeader ───────────────────────────────────────────────────────────────
function PageHeader({ eyebrow, title, children }: {
  eyebrow: string
  title: string
  children?: any
}) {
  return (
    <div class="page-header">
      <div class="page-header-left">
        <span class="page-header-eyebrow">{eyebrow}</span>
        <h1 class="page-header-title">{title}</h1>
      </div>
      {children && <div class="page-header-actions">{children}</div>}
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────
function Overview() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [recent, setRecent] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchStats(), fetchMessages({ limit: 10 })])
      .then(([s, m]) => { setStats(s); setRecent(m.results) })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>
  if (error) return <div class="page-content"><div class="empty-state"><div class="empty-state-text">&gt; {error}</div></div></div>

  return (
    <>
      <PageHeader eyebrow="// dashboard" title="Overview" />
      <div class="page-content">
        {stats && (
          <section class="section">
            <div class="section-label">Stats</div>
            <div class="stat-grid">
              <div class="stat-card">
                <div class="stat-label">Messages</div>
                <div class="stat-value">{fmtNum(stats.total_messages)}</div>
                <div class="stat-delta">&gt; all time</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Chats</div>
                <div class="stat-value">{fmtNum(stats.total_chats)}</div>
                <div class="stat-delta">&gt; indexed</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Contacts</div>
                <div class="stat-value">{fmtNum(stats.total_contacts)}</div>
                <div class="stat-delta">&gt; known</div>
              </div>
              {stats.earliest_message_at && (
                <div class="stat-card">
                  <div class="stat-label">Since</div>
                  <div class="stat-value" style="font-size:18px">
                    {new Date(stats.earliest_message_at * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                  </div>
                  <div class="stat-delta">&gt; earliest message</div>
                </div>
              )}
            </div>
          </section>
        )}

        <section class="section">
          <div class="section-label">Recent Messages</div>
          {recent.length === 0
            ? <div class="empty-state"><div class="empty-state-text">&gt; no messages yet</div></div>
            : recent.map(m => (
              <div key={m.id} class="message-card">
                <div class="message-meta">
                  <span class="message-chat">{m.chat_name || m.tg_chat_id}</span>
                  <span>&mdash;</span>
                  <span>{m.sender_username ? `@${m.sender_username}` : m.sender_first_name || m.sender_id}</span>
                  <span style="margin-left:auto">{fmtTs(m.sent_at)}</span>
                </div>
                <div class="message-text">{m.text}</div>
              </div>
            ))
          }
        </section>
      </div>
    </>
  )
}

// ── Search ───────────────────────────────────────────────────────────────────
function Search() {
  const [q, setQ] = useState('')
  const [chatType, setChatType] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)

  const run = useCallback(async () => {
    setLoading(true)
    setError('')
    setSearched(true)
    try {
      const r = await fetchMessages({ q: q || undefined, chat_type: chatType || undefined, limit: 50 })
      setResults(r.results)
      setTotal(r.total)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [q, chatType])

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') run()
  }

  return (
    <>
      <PageHeader eyebrow="// search" title="Message Search" />
      <div class="page-content">
        <div class="search-row">
          <input class="search-input" type="text" placeholder="search messages..."
            value={q} onInput={(e: any) => setQ(e.target.value)} onKeyDown={onKey} />
          <select class="search-input" value={chatType} onChange={(e: any) => setChatType(e.target.value)}>
            <option value="">all types</option>
            <option value="group">group</option>
            <option value="supergroup">supergroup</option>
            <option value="channel">channel</option>
            <option value="private">private</option>
          </select>
          <button class="btn btn-primary" onClick={run} disabled={loading}>
            {loading ? <span class="spinner" /> : '// search'}
          </button>
        </div>

        {error && <div class="form-error">&gt; {error}</div>}

        {searched && !loading && (
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-secondary)">
            &gt; {fmtNum(total)} result{total !== 1 ? 's' : ''}
          </div>
        )}

        {results.map(m => (
          <div key={m.id} class="message-card">
            <div class="message-meta">
              <span class="message-chat">{m.chat_name || m.tg_chat_id}</span>
              <span class={`badge ${chatTypeBadge(m.chat_type)}`}>{m.chat_type}</span>
              <span style="margin-left:auto">{fmtTs(m.sent_at)}</span>
            </div>
            <div class="message-text">{m.text}</div>
            <div class="message-meta" style="margin-top:2px">
              <span class="muted mono">{m.sender_username ? `@${m.sender_username}` : m.sender_first_name || m.sender_id}</span>
            </div>
          </div>
        ))}

        {searched && !loading && results.length === 0 && (
          <div class="empty-state">
            <div class="empty-state-text">&gt; no results</div>
          </div>
        )}
      </div>
    </>
  )
}

// ── Chats ─────────────────────────────────────────────────────────────────
function Chats({ onSelectChat }: { onSelectChat: (id: string, name: string) => void }) {
  const [chats, setChats] = useState<Chat[]>([])
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Debounced search — fires 300ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearching(true)
      setError('')
      setOffset(0)
      fetchChats({ name: query || undefined })
        .then(rows => {
          setChats(rows)
          setHasMore(rows.length === PAGE_SIZE)
        })
        .catch(err => setError(err.message))
        .finally(() => { setSearching(false); setInitialLoading(false) })
    }, query ? 300 : 0)
    return () => clearTimeout(timer)
  }, [query])

  function loadMore() {
    const nextOffset = offset + PAGE_SIZE
    setLoadingMore(true)
    fetchChats({ offset: nextOffset, name: query || undefined })
      .then(rows => {
        setChats(prev => [...prev, ...rows])
        setOffset(nextOffset)
        setHasMore(rows.length === PAGE_SIZE)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoadingMore(false))
  }

  // Infinite scroll via IntersectionObserver on sentinel div
  useEffect(() => {
    if (!sentinelRef.current) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loadingMore) loadMore()
    }, { threshold: 0.1 })
    obs.observe(sentinelRef.current)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, offset, query])

  return (
    <>
      <PageHeader eyebrow="// chats" title="Indexed Chats">
        <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary)">
          {!initialLoading && <>{fmtNum(chats.length)}{hasMore ? '+' : ''} shown</>}
        </span>
      </PageHeader>
      <div class="page-content">
        {error && <div class="form-error">&gt; {error}</div>}
        <div class="search-row">
          <input class="search-input" type="text" placeholder="search chats..."
            value={query} onInput={(e: any) => setQuery(e.target.value)} />
        </div>
        {initialLoading || searching
          ? <div class="empty-state"><span class="spinner" /></div>
          : (
            <>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Chat</th>
                      <th>Type</th>
                      <th>Messages</th>
                      <th>Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chats.length === 0
                      ? <tr><td colSpan={4} style="text-align:center;color:var(--text-secondary)">&gt; none</td></tr>
                      : chats.map(c => (
                        <tr key={c.tg_chat_id} style="cursor:pointer"
                          onClick={() => onSelectChat(c.tg_chat_id, c.chat_name || c.tg_chat_id)}>
                          <td>
                            <div style="font-weight:500">{c.chat_name || '(unnamed)'}</div>
                            <div class="muted mono" style="font-size:11px">{c.tg_chat_id}</div>
                          </td>
                          <td><span class={`badge ${chatTypeBadge(c.chat_type)}`}>{c.chat_type}</span></td>
                          <td class="mono accent">{fmtNum(c.message_count)}</td>
                          <td class="muted mono">{c.last_message_at ? fmtTs(c.last_message_at) : '—'}</td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
              <div ref={sentinelRef} style="height:1px" />
              {loadingMore && (
                <div class="empty-state" style="padding:12px 0">
                  <span class="spinner" />
                </div>
              )}
            </>
          )
        }
      </div>
    </>
  )
}

// ── Contacts ──────────────────────────────────────────────────────────────
function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const sentinelRef = useRef<HTMLDivElement>(null)
  const myAccountId = getAuth()?.accountId ?? ''

  // Debounced search — fires 300ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearching(true)
      setError('')
      setOffset(0)
      fetchContacts({ search: query || undefined })
        .then(rows => {
          setContacts(rows)
          setHasMore(rows.length === PAGE_SIZE)
        })
        .catch(err => setError(err.message))
        .finally(() => { setSearching(false); setInitialLoading(false) })
    }, query ? 300 : 0)
    return () => clearTimeout(timer)
  }, [query])

  function loadMore() {
    const nextOffset = offset + PAGE_SIZE
    setLoadingMore(true)
    fetchContacts({ offset: nextOffset, search: query || undefined })
      .then(rows => {
        setContacts(prev => [...prev, ...rows])
        setOffset(nextOffset)
        setHasMore(rows.length === PAGE_SIZE)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoadingMore(false))
  }

  // Infinite scroll via IntersectionObserver on sentinel div
  useEffect(() => {
    if (!sentinelRef.current) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loadingMore) loadMore()
    }, { threshold: 0.1 })
    obs.observe(sentinelRef.current)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, offset, query])

  return (
    <>
      <PageHeader eyebrow="// contacts" title="Known Contacts">
        <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary)">
          {!initialLoading && <>{fmtNum(contacts.length)}{hasMore ? '+' : ''} shown</>}
        </span>
      </PageHeader>
      <div class="page-content">
        {error && <div class="form-error">&gt; {error}</div>}
        <div class="search-row">
          <input class="search-input" type="text" placeholder="search contacts..."
            value={query} onInput={(e: any) => setQuery(e.target.value)} />
        </div>
        {initialLoading || searching
          ? <div class="empty-state"><span class="spinner" /></div>
          : (
            <>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Username</th>
                      <th>Phone</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.length === 0
                      ? <tr><td colSpan={4} style="text-align:center;color:var(--text-secondary)">&gt; none</td></tr>
                      : contacts.map(c => {
                          const isMe = myAccountId !== '' && c.tg_user_id === myAccountId
                          return (
                            <tr key={c.tg_user_id}>
                              <td>
                                <div style="font-weight:500;display:flex;align-items:center;gap:6px">
                                  {[c.first_name, c.last_name].filter(Boolean).join(' ') || '(unnamed)'}
                                  {isMe && <span class="badge badge-success" style="font-size:10px;padding:1px 5px">you</span>}
                                </div>
                                <div class="muted mono" style="font-size:11px">{c.tg_user_id}</div>
                              </td>
                              <td class="mono accent">{c.username ? `@${c.username}` : '—'}</td>
                              <td class="mono muted">{c.phone ?? '—'}</td>
                              <td>
                                {c.is_bot
                                  ? <span class="badge badge-warning">bot</span>
                                  : <span class="badge badge-neutral">user</span>}
                              </td>
                            </tr>
                          )
                        })
                    }
                  </tbody>
                </table>
              </div>
              <div ref={sentinelRef} style="height:1px" />
              {loadingMore && (
                <div class="empty-state" style="padding:12px 0">
                  <span class="spinner" />
                </div>
              )}
            </>
          )
        }
      </div>
    </>
  )
}

// ── ChatView ──────────────────────────────────────────────────────────────
type BubbleGroup = { sender_id: string; senderLabel: string; isSelf: boolean; messages: Message[] }

function ChatView({ chat, onBack }: { chat: { id: string; name: string }; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [nextAfterId, setNextAfterId] = useState<number | null>(null)
  const [nextAfterSentAt, setNextAfterSentAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const accountId = getAuth()?.accountId ?? ''

  useEffect(() => {
    fetchHistory({ chat_id: chat.id, limit: 50 })
      .then((r: HistoryResult) => {
        setMessages(r.messages)
        setNextAfterId(r.next_after_id)
        setNextAfterSentAt(r.next_after_sent_at)
      })
      .catch((err: any) => setError(err.message))
      .finally(() => setLoading(false))
  }, [chat.id])

  function loadMore() {
    if (!nextAfterId) return
    setLoadingMore(true)
    fetchHistory({ chat_id: chat.id, limit: 50, after_id: nextAfterId, after_sent_at: nextAfterSentAt ?? undefined })
      .then((r: HistoryResult) => {
        setMessages(prev => [...prev, ...r.messages])
        setNextAfterId(r.next_after_id)
        setNextAfterSentAt(r.next_after_sent_at)
      })
      .catch((err: any) => setError(err.message))
      .finally(() => setLoadingMore(false))
  }

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>

  // Group consecutive messages from the same sender
  const groups: BubbleGroup[] = []
  for (const m of messages) {
    const isSelf = !!accountId && m.sender_id === accountId
    const label = m.sender_username ? `@${m.sender_username}` : m.sender_first_name || m.sender_id
    const last = groups[groups.length - 1]
    if (last && last.sender_id === m.sender_id) {
      last.messages.push(m)
    } else {
      groups.push({ sender_id: m.sender_id, senderLabel: label, isSelf, messages: [m] })
    }
  }

  return (
    <>
      <PageHeader eyebrow="// chats" title={chat.name}>
        <button class="btn btn-ghost" style="font-size:12px" onClick={onBack}>
          ← back
        </button>
      </PageHeader>
      <div class="chat-scroll">
        {error && <div class="form-error" style="margin-bottom:8px">&gt; {error}</div>}
        {nextAfterId && (
          <button class="btn btn-ghost" style="width:100%;justify-content:center;margin-bottom:16px"
            onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <span class="spinner" /> : '// load older'}
          </button>
        )}
        {messages.length === 0
          ? <div class="empty-state"><div class="empty-state-text">&gt; no messages</div></div>
          : groups.map((g, gi) => (
            <div key={`${g.sender_id}-${gi}`} class={`bubble-group ${g.isSelf ? 'bubble-group--self' : 'bubble-group--other'}`}>
              {!g.isSelf && (
                <div class="bubble-sender">{g.senderLabel}</div>
              )}
              {g.messages.map((m, mi) => {
                const isLast = mi === g.messages.length - 1
                return (
                  <div key={m.id} class={`bubble ${g.isSelf ? 'bubble--self' : 'bubble--other'}`}>
                    <span class="bubble-text">{m.text || <span class="muted">[media]</span>}</span>
                    {isLast && (
                      <span class="bubble-ts">{fmtTs(m.sent_at)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        }
      </div>
    </>
  )
}

// ── Cron Builder (for NewJobForm "Custom" preset) ────────────────────────
type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
const DAY_LABELS: { key: DayKey; label: string; short: string }[] = [
  { key: 'mon', label: 'Monday',    short: 'Mon' },
  { key: 'tue', label: 'Tuesday',   short: 'Tue' },
  { key: 'wed', label: 'Wednesday', short: 'Wed' },
  { key: 'thu', label: 'Thursday',  short: 'Thu' },
  { key: 'fri', label: 'Friday',    short: 'Fri' },
  { key: 'sat', label: 'Saturday',  short: 'Sat' },
  { key: 'sun', label: 'Sunday',    short: 'Sun' },
]
// Standard cron DOW: Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
const DAY_DOW: Record<DayKey, number> = { mon:1, tue:2, wed:3, thu:4, fri:5, sat:6, sun:0 }

type DayPreset = 'every' | 'weekdays' | 'weekends' | 'custom'

function buildCron(hour: number, minute: number, dayPreset: DayPreset, customDays: Set<DayKey>): string {
  let dow = '*'
  if (dayPreset === 'weekdays') dow = '1-5'
  else if (dayPreset === 'weekends') dow = '0,6'
  else if (dayPreset === 'custom' && customDays.size > 0 && customDays.size < 7) {
    const sorted = DAY_LABELS.filter(d => customDays.has(d.key)).map(d => DAY_DOW[d.key])
    dow = sorted.join(',')
  }
  return `${minute} ${hour} * * ${dow}`
}

function describeCron(hour: number, minute: number, dayPreset: DayPreset, customDays: Set<DayKey>): string {
  const timeStr = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`
  let dayStr = ''
  if (dayPreset === 'every') dayStr = 'every day'
  else if (dayPreset === 'weekdays') dayStr = 'every weekday'
  else if (dayPreset === 'weekends') dayStr = 'every weekend'
  else if (dayPreset === 'custom') {
    if (customDays.size === 0) dayStr = 'no days selected'
    else if (customDays.size === 7) dayStr = 'every day'
    else dayStr = DAY_LABELS.filter(d => customDays.has(d.key)).map(d => d.short).join(', ')
  }
  return `Runs ${dayStr} at ${timeStr}`
}

function CronBuilder({ rawValue, onChange }: { rawValue: string; onChange: (cron: string) => void }) {
  const [hour, setHour] = useState(8)
  const [minute, setMinute] = useState(0)
  const [dayPreset, setDayPreset] = useState<DayPreset>('every')
  const [customDays, setCustomDays] = useState<Set<DayKey>>(new Set())

  function syncUp(h: number, m: number, dp: DayPreset, cd: Set<DayKey>) {
    onChange(buildCron(h, m, dp, cd))
  }

  function setH(h: number) { setHour(h); syncUp(h, minute, dayPreset, customDays) }
  function setM(m: number) { setMinute(m); syncUp(hour, m, dayPreset, customDays) }
  function setDp(dp: DayPreset) { setDayPreset(dp); syncUp(hour, minute, dp, customDays) }
  function toggleDay(key: DayKey) {
    setCustomDays(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      syncUp(hour, minute, dayPreset, next)
      return next
    })
  }

  const dpOptions: { key: DayPreset; label: string }[] = [
    { key: 'every',    label: 'Every day' },
    { key: 'weekdays', label: 'Weekdays' },
    { key: 'weekends', label: 'Weekends' },
    { key: 'custom',   label: 'Pick days' },
  ]

  const preview = describeCron(hour, minute, dayPreset, customDays)

  return (
    <div style="display:flex;flex-direction:column;gap:12px;padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-top:8px">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="muted mono" style="font-size:11px;width:60px">Time</span>
        <select class="form-input" style="width:90px;padding:5px 8px;font-size:12px"
          value={hour} onChange={(e: any) => setH(Number(e.target.value))}>
          {Array.from({length:24},(_,i)=>i).map(h => (
            <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>
          ))}
        </select>
        <select class="form-input" style="width:70px;padding:5px 8px;font-size:12px"
          value={minute} onChange={(e: any) => setM(Number(e.target.value))}>
          {[0,15,30,45].map(m => (
            <option key={m} value={m}>:{String(m).padStart(2,'0')}</option>
          ))}
        </select>
      </div>

      <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <span class="muted mono" style="font-size:11px;width:60px;padding-top:6px">Days</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          {dpOptions.map(opt => (
            <button key={opt.key} type="button"
              class={`btn ${dayPreset === opt.key ? 'btn-primary' : 'btn-ghost'}`}
              style="font-size:11px;padding:4px 10px"
              onClick={() => setDp(opt.key)}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {dayPreset === 'custom' && (
        <div style="display:flex;gap:4px;flex-wrap:wrap;padding-left:70px">
          {DAY_LABELS.map(d => (
            <button key={d.key} type="button"
              class={`btn ${customDays.has(d.key) ? 'btn-primary' : 'btn-ghost'}`}
              style="font-size:11px;padding:4px 9px"
              onClick={() => toggleDay(d.key)}>
              {d.short}
            </button>
          ))}
        </div>
      )}

      <div class="mono" style="font-size:11px;color:var(--accent);padding-left:70px">
        &gt; {preview}
      </div>

      <div style="padding-left:70px">
        <label class="muted mono" style="font-size:10px;display:block;margin-bottom:4px">Advanced — cron expression</label>
        <input class="form-input" type="text" placeholder="0 8 * * *"
          style="font-family:'JetBrains Mono',monospace;font-size:12px;padding:5px 10px"
          value={rawValue}
          onInput={(e: any) => onChange(e.target.value)} />
      </div>
    </div>
  )
}

// ── Automation ────────────────────────────────────────────────────────────
const SCHEDULE_PRESETS = [
  { label: 'Every 15 min',  value: '*/15 * * * *' },
  { label: 'Hourly',        value: '0 * * * *' },
  { label: 'Daily 8am',     value: '0 8 * * *' },
  { label: 'Daily midnight',value: '0 0 * * *' },
  { label: 'Weekly Monday', value: '0 8 * * 1' },
  { label: 'Custom',        value: 'custom' },
]

const MODEL_PRESETS: Record<string, { model: string; api_key_ref: string }> = {
  anthropic: { model: 'claude-haiku-4-5-20251001', api_key_ref: 'ANTHROPIC_API_KEY' },
  openai:    { model: 'gpt-4o-mini',               api_key_ref: 'OPENAI_API_KEY' },
  cloudflare: { model: '@cf/meta/llama-3.1-8b-instruct', api_key_ref: 'CF_AI_TOKEN' },
}

function NewJobForm({ onCreated, onCancel }: { onCreated: (job: Job) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedulePreset, setSchedulePreset] = useState('0 8 * * *')
  const [customSchedule, setCustomSchedule] = useState('0 8 * * *')
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState(MODEL_PRESETS['anthropic'].model)
  const [apiKeyRef, setApiKeyRef] = useState(MODEL_PRESETS['anthropic'].api_key_ref)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ token: string; token_note: string } | null>(null)

  function onProviderChange(p: string) {
    setProvider(p)
    const preset = MODEL_PRESETS[p]
    if (preset) { setModel(preset.model); setApiKeyRef(preset.api_key_ref) }
  }

  async function submit(e: Event) {
    e.preventDefault()
    setError('')
    const schedule = schedulePreset === 'custom' ? customSchedule.trim() : schedulePreset
    if (!schedule) { setError('Schedule is required'); return }
    const payload: CreateJobPayload = {
      name: name.trim(),
      task_prompt: prompt.trim(),
      schedule,
      model_config: { provider, model: model.trim(), api_key_ref: apiKeyRef.trim() },
    }
    setSaving(true)
    try {
      const res = await createJob(payload)
      setCreated({ token: res.token, token_note: res.token_note })
      onCreated({
        id: res.job_id,
        name: payload.name,
        enabled: true,
        schedule,
        trigger_type: null,
        last_run_at: null,
        cooldown_secs: 3600,
        token_label: `job:${payload.name}`,
      })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (created) {
    return (
      <div class="section" style="border:1px solid var(--accent);border-radius:6px;padding:20px">
        <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--accent);margin-bottom:12px">&gt; job created</div>
        <div style="margin-bottom:8px;font-size:13px;font-weight:500">Save this token — it cannot be retrieved again:</div>
        <div class="mono" style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 14px;font-size:12px;word-break:break-all;margin-bottom:16px;user-select:all">
          {created.token}
        </div>
        <div class="muted mono" style="font-size:11px;margin-bottom:16px">{created.token_note}</div>
        <button class="btn btn-primary" onClick={onCancel}>// done</button>
      </div>
    )
  }

  return (
    <form class="section" style="border:1px solid var(--border);border-radius:6px;padding:20px;display:flex;flex-direction:column;gap:16px" onSubmit={submit}>
      <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary)">// new job</div>

      <div class="form-group">
        <label class="form-label">Name</label>
        <input class="form-input" type="text" placeholder="daily-digest" required
          value={name} onInput={(e: any) => setName(e.target.value)} />
      </div>

      <div class="form-group">
        <label class="form-label">Task — what should the AI do?</label>
        <textarea class="form-input" rows={4} placeholder="Summarise unread messages from the last 24 hours and send me a digest."
          style="resize:vertical;font-family:'JetBrains Mono',monospace;font-size:12px"
          value={prompt} onInput={(e: any) => setPrompt(e.target.value)} required />
      </div>

      <div class="form-group">
        <label class="form-label">Schedule</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          {SCHEDULE_PRESETS.map(p => (
            <button key={p.value} type="button"
              class={`btn ${schedulePreset === p.value ? 'btn-primary' : 'btn-ghost'}`}
              style="font-size:11px;padding:4px 10px"
              onClick={() => setSchedulePreset(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
        {schedulePreset === 'custom' && (
          <CronBuilder rawValue={customSchedule} onChange={setCustomSchedule} />
        )}
      </div>

      <div class="form-group">
        <label class="form-label">Model</label>
        <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
          <select class="form-input" style="width:140px" value={provider} onChange={(e: any) => onProviderChange(e.target.value)}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="cloudflare">Cloudflare AI</option>
          </select>
          <input class="form-input" type="text" placeholder="model name"
            style="flex:1;min-width:180px;font-family:'JetBrains Mono',monospace;font-size:12px"
            value={model} onInput={(e: any) => setModel(e.target.value)} required />
          <input class="form-input" type="text" placeholder="API key env var"
            style="width:160px;font-family:'JetBrains Mono',monospace;font-size:12px"
            value={apiKeyRef} onInput={(e: any) => setApiKeyRef(e.target.value)} required />
        </div>
        <div class="muted mono" style="font-size:11px;margin-top:6px">
          API key env var must be set as a Cloudflare Worker secret
        </div>
      </div>

      {error && <div class="form-error">&gt; {error}</div>}

      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" type="submit" disabled={saving}>
          {saving ? <span class="spinner" /> : '// create job'}
        </button>
        <button class="btn btn-ghost" type="button" onClick={onCancel}>cancel</button>
      </div>
    </form>
  )
}

function Automation() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toggling, setToggling] = useState<string | null>(null)
  const [tab, setTab] = useState<'jobs' | 'activity'>('jobs')
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState('')
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    fetchJobs()
      .then(setJobs)
      .catch((err: any) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleToggle(job: Job) {
    setToggling(job.name)
    try {
      await toggleJob(job.name, !job.enabled)
      setJobs(prev => prev.map(j => j.name === job.name ? { ...j, enabled: !j.enabled } : j))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setToggling(null)
    }
  }

  function switchTab(t: 'jobs' | 'activity') {
    setTab(t)
    if (t === 'activity' && auditLog.length === 0 && !auditLoading) {
      setAuditLoading(true)
      fetchAuditLog()
        .then(setAuditLog)
        .catch((err: any) => setAuditError(err.message))
        .finally(() => setAuditLoading(false))
    }
  }

  const actionBadge = (a: string) => ({
    send: 'badge-success', edit: 'badge-accent', delete: 'badge-error', forward: 'badge-neutral',
  } as Record<string, string>)[a] ?? 'badge-neutral'

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>

  return (
    <>
      <PageHeader eyebrow="// automation" title="Observer Jobs">
        {tab === 'jobs' && !showForm && (
          <button class="btn btn-primary" style="font-size:12px" onClick={() => setShowForm(true)}>
            + new job
          </button>
        )}
      </PageHeader>
      <div class="page-content" style="padding-top:0;gap:0">
        <div class="filter-bar">
          <button class={`filter-tab${tab === 'jobs' ? ' active' : ''}`} onClick={() => switchTab('jobs')}>// jobs</button>
          <button class={`filter-tab${tab === 'activity' ? ' active' : ''}`} onClick={() => switchTab('activity')}>// activity</button>
        </div>
        <div style="height:24px" />
        {error && <div class="form-error" style="margin-bottom:16px">&gt; {error}</div>}

        {tab === 'jobs' && (
          <div style="display:flex;flex-direction:column;gap:16px">
            {showForm && (
              <NewJobForm
                onCreated={job => { setJobs(prev => [...prev, job]); }}
                onCancel={() => setShowForm(false)}
              />
            )}
            {jobs.length === 0 && !showForm
              ? <div class="empty-state"><div class="empty-state-text">&gt; no jobs yet — click + new job</div></div>
              : jobs.length > 0 && (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr><th>Job</th><th>Schedule</th><th>Last Run</th><th>Token</th><th>On/Off</th></tr>
                    </thead>
                    <tbody>
                      {jobs.map(j => (
                        <tr key={j.id}>
                          <td style="font-weight:500">{j.name}</td>
                          <td class="mono muted" style="font-size:11px">{j.schedule ?? (j.trigger_type ? <span class="badge badge-accent">{j.trigger_type}</span> : '—')}</td>
                          <td class="muted mono">{j.last_run_at ? fmtTs(j.last_run_at) : '—'}</td>
                          <td class="muted mono" style="font-size:11px">{j.token_label ?? '—'}</td>
                          <td>
                            <button
                              class={`btn ${j.enabled ? 'btn-primary' : 'btn-ghost'}`}
                              style="padding:4px 10px;font-size:11px"
                              onClick={() => handleToggle(j)}
                              disabled={toggling === j.name}
                            >
                              {toggling === j.name ? <span class="spinner" /> : j.enabled ? 'on' : 'off'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </div>
        )}

        {tab === 'activity' && (
          auditLoading ? <div class="empty-state"><span class="spinner" /></div>
          : auditError ? <div class="form-error">&gt; {auditError}</div>
          : auditLog.length === 0 ? <div class="empty-state"><div class="empty-state-text">&gt; no activity</div></div>
          : (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Action</th><th>Chat</th><th>Token</th><th>Time</th></tr></thead>
                <tbody>
                  {auditLog.map(e => (
                    <tr key={e.id}>
                      <td><span class={`badge ${actionBadge(e.action)}`}>{e.action}</span></td>
                      <td class="mono muted" style="font-size:11px">{e.target_chat_id ?? '—'}</td>
                      <td class="mono muted" style="font-size:11px">{e.token_label ?? '—'}</td>
                      <td class="muted mono">{fmtTs(e.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </>
  )
}

// ── Config ────────────────────────────────────────────────────────────────
function Config() {
  const [tab, setTab] = useState<'global' | 'chats' | 'system'>('global')
  const [globalConfig, setGlobalConfigState] = useState<GlobalConfig | null>(null)
  const [chatConfigs, setChatConfigs] = useState<ChatConfig[]>([])
  const [backfillJobs, setBackfillJobs] = useState<BackfillJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Global config saving state
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Mass send — committed (display) values
  const [maxRecipients, setMaxRecipients] = useState(0)
  const [contactsOnly, setContactsOnly] = useState(true)
  // Mass send — inline edit state per field
  const [editingMaxRecipients, setEditingMaxRecipients] = useState(false)
  const [draftMaxRecipients, setDraftMaxRecipients] = useState('')
  const [editingContactsOnly, setEditingContactsOnly] = useState(false)
  const [draftContactsOnly, setDraftContactsOnly] = useState(true)

  // Chat config inline editing
  const [editingChat, setEditingChat] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editSync, setEditSync] = useState<'include' | 'exclude' | null>(null)
  const [chatSaving, setChatSaving] = useState(false)
  const [chatError, setChatError] = useState('')

  useEffect(() => {
    Promise.all([fetchGlobalConfig(), fetchChatsConfig(), fetchBackfill()])
      .then(([gc, cc, bf]) => {
        setGlobalConfigState(gc)
        setMaxRecipients(gc.mass_send_max_recipients)
        setContactsOnly(gc.mass_send_contacts_only)
        setChatConfigs(cc)
        setBackfillJobs(bf)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  async function saveGlobal(patch: Partial<GlobalConfig>) {
    setSaving(true)
    setSaved(false)
    try {
      await setGlobalConfig(patch)
      setGlobalConfigState(prev => prev ? { ...prev, ...patch } : prev)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function saveSyncMode(mode: GlobalConfig['sync_mode']) {
    saveGlobal({ sync_mode: mode })
  }

  function confirmMaxRecipients() {
    const v = parseInt(draftMaxRecipients, 10)
    if (!Number.isFinite(v) || v < 1) { setError('Recipient cap must be a positive number'); return }
    setMaxRecipients(v)
    setEditingMaxRecipients(false)
    saveGlobal({ mass_send_max_recipients: v })
  }

  function confirmContactsOnly() {
    setContactsOnly(draftContactsOnly)
    setEditingContactsOnly(false)
    saveGlobal({ mass_send_contacts_only: draftContactsOnly })
  }

  function startEditChat(c: ChatConfig) {
    setEditingChat(c.tg_chat_id)
    setEditLabel(c.label ?? '')
    setEditSync(c.sync ?? null)
    setChatError('')
  }

  async function saveChat(c: ChatConfig) {
    setChatSaving(true)
    setChatError('')
    try {
      await updateChatConfig({
        tg_chat_id: c.tg_chat_id,
        chat_name: c.chat_name,
        sync: editSync,
        label: editLabel.trim() || null,
      })
      setChatConfigs(prev => prev.map(x =>
        x.tg_chat_id === c.tg_chat_id
          ? { ...x, label: editLabel.trim() || null, sync: editSync, updated_at: Math.floor(Date.now() / 1000) }
          : x
      ))
      setEditingChat(null)
    } catch (err: any) {
      setChatError(err.message)
    } finally {
      setChatSaving(false)
    }
  }

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>

  const tabs: Array<{ id: 'global' | 'chats' | 'system'; label: string }> = [
    { id: 'global', label: '// global' },
    { id: 'chats',  label: '// chat config' },
    { id: 'system', label: '// system' },
  ]

  const backfillSummary = {
    total:    backfillJobs.length,
    complete: backfillJobs.filter(j => j.status === 'complete').length,
    pending:  backfillJobs.filter(j => j.status === 'pending' || j.status === 'in_progress').length,
    failed:   backfillJobs.filter(j => j.status === 'failed').length,
  }

  return (
    <>
      <PageHeader eyebrow="// config" title="Configuration" />
      <div class="page-content" style="padding-top:0;gap:0">
        <div class="filter-bar">
          {tabs.map(t => (
            <button key={t.id} class={`filter-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div style="height:24px" />
        {error && <div class="form-error" style="margin-bottom:16px">&gt; {error}</div>}

        {tab === 'global' && globalConfig && (
          <div style="display:flex;flex-direction:column;gap:24px">
            <section class="section">
              <div class="section-label">Sync Mode</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                {(['all', 'whitelist', 'blacklist', 'none'] as const).map(mode => (
                  <button
                    key={mode}
                    class={`btn ${globalConfig.sync_mode === mode ? 'btn-primary' : 'btn-ghost'}`}
                    style="font-size:12px"
                    onClick={() => saveSyncMode(mode)}
                    disabled={saving}
                  >
                    {mode}
                  </button>
                ))}
                {saving && <span class="spinner" />}
                {saved && <span class="muted mono" style="font-size:11px;color:var(--accent)">&gt; saved</span>}
              </div>
              <div class="muted mono" style="font-size:11px;margin-top:8px">
                all = sync everything · whitelist = only included chats · blacklist = exclude listed chats · none = pause sync
              </div>
            </section>

            <section class="section">
              <div class="section-label">Mass Send Limits</div>
              <div style="display:flex;flex-direction:column;gap:14px">

                {/* Max recipients — read/edit */}
                <div style="display:flex;align-items:center;gap:12px">
                  <label class="muted mono" style="font-size:12px;width:180px">Max recipients per send</label>
                  {editingMaxRecipients ? (
                    <>
                      <input
                        class="search-input"
                        type="number" min="1" max="500"
                        style="width:80px;padding:5px 10px;font-size:13px"
                        value={draftMaxRecipients}
                        onInput={(e: any) => setDraftMaxRecipients(e.target.value)}
                      />
                      <button class="btn btn-primary" style="padding:4px 10px;font-size:12px"
                        onClick={confirmMaxRecipients} disabled={saving}>
                        {saving ? <span class="spinner" /> : '✓'}
                      </button>
                      <button class="btn btn-ghost" style="padding:4px 8px;font-size:12px"
                        onClick={() => setEditingMaxRecipients(false)}>
                        ✕
                      </button>
                    </>
                  ) : (
                    <>
                      <span class="mono" style="font-size:14px;font-weight:500">{maxRecipients}</span>
                      <button class="btn btn-ghost" style="padding:3px 8px;font-size:11px"
                        onClick={() => { setDraftMaxRecipients(String(maxRecipients)); setEditingMaxRecipients(true) }}
                        title="Edit">
                        ✎
                      </button>
                    </>
                  )}
                </div>

                {/* Contacts only — read/edit */}
                <div style="display:flex;align-items:center;gap:12px">
                  <label class="muted mono" style="font-size:12px;width:180px">Contacts only</label>
                  {editingContactsOnly ? (
                    <>
                      <button
                        class={`btn ${draftContactsOnly ? 'btn-primary' : 'btn-ghost'}`}
                        style="font-size:12px;padding:4px 14px"
                        onClick={() => setDraftContactsOnly(v => !v)}>
                        {draftContactsOnly ? 'on' : 'off'}
                      </button>
                      <button class="btn btn-primary" style="padding:4px 10px;font-size:12px"
                        onClick={confirmContactsOnly} disabled={saving}>
                        {saving ? <span class="spinner" /> : '✓'}
                      </button>
                      <button class="btn btn-ghost" style="padding:4px 8px;font-size:12px"
                        onClick={() => setEditingContactsOnly(false)}>
                        ✕
                      </button>
                    </>
                  ) : (
                    <>
                      <span class={`badge ${contactsOnly ? 'badge-success' : 'badge-neutral'}`}>
                        {contactsOnly ? 'on' : 'off'}
                      </span>
                      <span class="muted mono" style="font-size:11px">
                        {contactsOnly ? 'recipients must be in contacts' : 'any chat ID allowed'}
                      </span>
                      <button class="btn btn-ghost" style="padding:3px 8px;font-size:11px"
                        onClick={() => { setDraftContactsOnly(contactsOnly); setEditingContactsOnly(true) }}
                        title="Edit">
                        ✎
                      </button>
                    </>
                  )}
                </div>

                {saved && !editingMaxRecipients && !editingContactsOnly && (
                  <span class="muted mono" style="font-size:11px;color:var(--accent)">&gt; saved</span>
                )}
              </div>
            </section>
          </div>
        )}

        {tab === 'chats' && (
          <div style="display:flex;flex-direction:column;gap:16px">
            {chatError && <div class="form-error">&gt; {chatError}</div>}
            {chatConfigs.length === 0
              ? <div class="empty-state"><div class="empty-state-text">&gt; no chat config overrides</div></div>
              : (
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Chat</th>
                        <th>Label</th>
                        <th>Sync</th>
                        <th>Updated</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {chatConfigs.map(c => (
                        <tr key={c.tg_chat_id}>
                          <td>
                            <div style="font-weight:500">{c.chat_name || '(unnamed)'}</div>
                            <div class="muted mono" style="font-size:11px">{c.tg_chat_id}</div>
                          </td>
                          {editingChat === c.tg_chat_id ? (
                            <>
                              <td>
                                <input
                                  class="search-input"
                                  style="width:120px;padding:4px 8px;font-size:12px"
                                  type="text"
                                  placeholder="label"
                                  value={editLabel}
                                  onInput={(e: any) => setEditLabel(e.target.value)}
                                />
                              </td>
                              <td>
                                <select
                                  class="search-input"
                                  style="padding:4px 8px;font-size:12px"
                                  value={editSync ?? ''}
                                  onChange={(e: any) => setEditSync(e.target.value || null)}
                                >
                                  <option value="">inherit</option>
                                  <option value="include">include</option>
                                  <option value="exclude">exclude</option>
                                </select>
                              </td>
                              <td class="muted mono">{c.updated_at ? fmtTs(c.updated_at) : '—'}</td>
                              <td>
                                <div style="display:flex;gap:4px">
                                  <button class="btn btn-primary" style="padding:3px 10px;font-size:11px"
                                    onClick={() => saveChat(c)} disabled={chatSaving}>
                                    {chatSaving ? <span class="spinner" /> : 'save'}
                                  </button>
                                  <button class="btn btn-ghost" style="padding:3px 8px;font-size:11px"
                                    onClick={() => setEditingChat(null)}>
                                    ✕
                                  </button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              <td class="mono accent">{c.label ?? '—'}</td>
                              <td>
                                {c.sync === 'exclude'
                                  ? <span class="badge badge-error">exclude</span>
                                  : c.sync === 'include'
                                    ? <span class="badge badge-success">include</span>
                                    : <span class="muted mono" style="font-size:11px">inherit</span>}
                              </td>
                              <td class="muted mono">{c.updated_at ? fmtTs(c.updated_at) : '—'}</td>
                              <td>
                                <button class="btn btn-ghost" style="padding:3px 10px;font-size:11px"
                                  onClick={() => startEditChat(c)}>
                                  edit
                                </button>
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </div>
        )}

        {tab === 'system' && (
          <section class="section">
            <div class="section-label">Backfill Status</div>
            <div class="stat-grid">
              <div class="stat-card">
                <div class="stat-label">Total Chats</div>
                <div class="stat-value">{fmtNum(backfillSummary.total)}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Complete</div>
                <div class="stat-value" style="color:var(--accent)">{fmtNum(backfillSummary.complete)}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">In Progress</div>
                <div class="stat-value">{fmtNum(backfillSummary.pending)}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Failed</div>
                <div class="stat-value" style={backfillSummary.failed > 0 ? 'color:#ef4444' : ''}>{fmtNum(backfillSummary.failed)}</div>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  )
}

// ── Tokens ────────────────────────────────────────────────────────────────
function Tokens() {
  const [tokens, setTokens] = useState<AgentToken[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [newToken, setNewToken] = useState<{ token: string; label: string | null; role: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [formLabel, setFormLabel] = useState('')
  const [formRole, setFormRole] = useState('')
  const [formExpiry, setFormExpiry] = useState('')
  const [creating, setCreating] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([fetchTokens(), fetchRoles()])
      .then(([t, r]) => {
        setTokens(t)
        setRoles(r)
        if (r.length > 0) setFormRole(r[0].name)
      })
      .catch((e: any) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleRevoke(id: string) {
    if (confirmRevoke !== id) { setConfirmRevoke(id); return; }
    setRevoking(id)
    try {
      await revokeToken(id)
      setTokens(prev => prev.filter(t => t.id !== id))
      setConfirmRevoke(null)
    } catch (e: any) { setErr(e.message) }
    finally { setRevoking(null) }
  }

  async function handleCreate() {
    if (!formRole) { setFormErr('Select a role'); return; }
    setCreating(true)
    setFormErr(null)
    try {
      const payload: CreateTokenPayload = { role_name: formRole }
      if (formLabel.trim()) payload.label = formLabel.trim()
      if (formExpiry) payload.expires_at = Math.floor(new Date(formExpiry).getTime() / 1000)
      const res = await createToken(payload)
      setNewToken({ token: res.token, label: res.label, role: res.role })
      setShowForm(false)
      setFormLabel('')
      setFormExpiry('')
      fetchTokens().then(setTokens).catch(() => {})
    } catch (e: any) { setFormErr(e.message) }
    finally { setCreating(false) }
  }

  function fmtDate(ts: number | null) {
    if (!ts) return '—'
    return new Date(ts * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  function permBadges(acc: TokenAccount) {
    const perms: string[] = []
    if (acc.can_send) perms.push('send')
    if (acc.can_edit) perms.push('edit')
    if (acc.can_delete) perms.push('delete')
    if (acc.can_forward) perms.push('fwd')
    return perms
  }

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>
  if (err) return <div class="page-content"><div class="muted">{err}</div></div>

  return (
    <>
      <PageHeader eyebrow="// security" title="Agent Tokens">
        <button class="btn btn-primary" style="font-size:12px" onClick={() => { setShowForm(f => !f); setFormErr(null); }}>
          {showForm ? 'cancel' : '+ new token'}
        </button>
      </PageHeader>

      <div class="page-content" style="padding-top:0">

        {newToken && (
          <div style="background:var(--accent-subtle,rgba(16,185,129,.08));border:1px solid var(--accent);padding:20px;display:flex;flex-direction:column;gap:12px;margin-bottom:24px">
            <div style="font-family:JetBrains Mono,monospace;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent)">Token created — save it now</div>
            <div style="font-size:12px;color:var(--text-secondary)">This is the only time the token value is shown. It cannot be retrieved again.</div>
            <div style="display:flex;gap:8px;align-items:center">
              <code style="flex:1;background:var(--bg-alt,#0d1117);padding:10px 14px;font-family:JetBrains Mono,monospace;font-size:12px;word-break:break-all;border:1px solid var(--border)">{newToken.token}</code>
              <button class="btn btn-ghost" onClick={() => { navigator.clipboard.writeText(newToken.token); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                {copied ? 'copied' : 'copy'}
              </button>
            </div>
            <div style="font-size:12px;color:var(--text-secondary)">
              Role: <span style="color:var(--text-primary)">{newToken.role}</span>
              {newToken.label ? ` · ${newToken.label}` : ''}
            </div>
            <button class="btn btn-ghost" style="align-self:flex-start" onClick={() => setNewToken(null)}>dismiss</button>
          </div>
        )}

        {showForm && (
          <section class="section" style="margin-bottom:24px">
            <div class="section-label">New Token</div>
            <div style="display:flex;flex-direction:column;gap:12px;max-width:480px">
              <div class="form-group">
                <label class="form-label">Label (optional)</label>
                <input class="form-input" placeholder="e.g. Claude work assistant"
                  value={formLabel} onInput={(e: any) => setFormLabel(e.target.value)} />
              </div>
              <div class="form-group">
                <label class="form-label">Role</label>
                <select class="form-input" value={formRole} onChange={(e: any) => setFormRole(e.target.value)}>
                  {roles.map(r => (
                    <option key={r.id} value={r.name}>
                      {r.name} ({r.read_mode}{r.can_send ? ', send' : ''})
                    </option>
                  ))}
                </select>
                {roles.length === 0 && (
                  <div class="form-error">No roles found. Create roles via MCP or DB first.</div>
                )}
              </div>
              <div class="form-group">
                <label class="form-label">Expiry (optional)</label>
                <input class="form-input" type="date" value={formExpiry}
                  onChange={(e: any) => setFormExpiry(e.target.value)} />
              </div>
              {formErr && <div class="form-error">&gt; {formErr}</div>}
              <button class="btn btn-primary" style="align-self:flex-start" onClick={handleCreate} disabled={creating}>
                {creating ? <span class="spinner" /> : 'create token'}
              </button>
            </div>
          </section>
        )}

        <section class="section">
          <div class="section-label">{tokens.length} token{tokens.length !== 1 ? 's' : ''}</div>
          {tokens.length === 0 ? (
            <div class="empty-state">
              <div class="empty-state-text">&gt; no agent tokens yet — click + new token</div>
            </div>
          ) : (
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Role</th>
                    <th>Permissions</th>
                    <th>Last used</th>
                    <th>Expires</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map(t => (
                    <tr key={t.id}>
                      <td>
                        <span class="mono">{t.label ?? <span class="muted">—</span>}</span>
                        <div class="muted mono" style="font-size:10px;margin-top:2px">#{t.id}</div>
                      </td>
                      <td>
                        {t.accounts.map(a => (
                          <div key={a.account_id} style="display:flex;flex-direction:column;gap:2px;margin-bottom:4px">
                            <span class="badge badge-accent">{a.role}</span>
                            <span class="muted mono" style="font-size:10px">{a.account_id}</span>
                          </div>
                        ))}
                      </td>
                      <td>
                        {t.accounts.map(a => (
                          <div key={a.account_id} style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px">
                            <span class="badge badge-neutral">{a.read_mode}</span>
                            {permBadges(a).map(p => <span key={p} class="badge badge-warning">{p}</span>)}
                          </div>
                        ))}
                      </td>
                      <td class="muted mono" style="font-size:12px">{fmtDate(t.last_used_at)}</td>
                      <td class="muted mono" style="font-size:12px">
                        {t.expires_at
                          ? <span style={t.expires_at < Date.now() / 1000 ? 'color:var(--error,#ef4444)' : ''}>{fmtDate(t.expires_at)}</span>
                          : <span class="muted">never</span>}
                      </td>
                      <td class="muted mono" style="font-size:12px">{fmtDate(t.created_at)}</td>
                      <td>
                        {confirmRevoke === t.id ? (
                          <div style="display:flex;gap:6px;align-items:center">
                            <span class="muted" style="font-size:11px;font-family:JetBrains Mono,monospace">confirm?</span>
                            <button
                              class="btn btn-danger"
                              style="padding:4px 10px;font-size:11px"
                              onClick={() => handleRevoke(t.id)}
                              disabled={revoking === t.id}
                            >
                              {revoking === t.id ? <span class="spinner" /> : 'revoke'}
                            </button>
                            <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onClick={() => setConfirmRevoke(null)}>
                              cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            class="btn btn-ghost"
                            style="padding:4px 10px;font-size:11px;color:var(--error,#ef4444);border-color:var(--error,#ef4444)"
                            onClick={() => handleRevoke(t.id)}
                          >
                            revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

// ── App ───────────────────────────────────────────────────────────────────
export function App() {
  const [authed, setAuthed] = useState(() => !!getAuth())
  const [screen, setScreen] = useState<Screen>('overview')
  const [selectedChat, setSelectedChat] = useState<{ id: string; name: string } | null>(null)

  function onLogout() {
    clearAuth()
    setAuthed(false)
  }

  function onNav(s: Screen) {
    setScreen(s)
    setSelectedChat(null)
  }

  if (!authed) {
    return <Login onAuth={() => setAuthed(true)} />
  }

  const accountId = getAuth()?.accountId ?? 'primary'

  if (selectedChat) {
    return (
      <div class="layout">
        <Sidebar screen={screen} onNav={onNav} onLogout={onLogout} accountId={accountId} />
        <main class="main">
          <ChatView chat={selectedChat} onBack={() => setSelectedChat(null)} />
        </main>
      </div>
    )
  }

  function renderScreen() {
    switch (screen) {
      case 'chats':
        return <Chats onSelectChat={(id, name) => setSelectedChat({ id, name })} />
      case 'overview':   return <Overview />
      case 'search':     return <Search />
      case 'contacts':   return <Contacts />
      case 'automation': return <Automation />
      case 'tokens':     return <Tokens />
      case 'config':     return <Config />
    }
  }

  return (
    <div class="layout">
      <Sidebar screen={screen} onNav={onNav} onLogout={onLogout} accountId={accountId} />
      <main class="main">
        {renderScreen()}
      </main>
    </div>
  )
}
