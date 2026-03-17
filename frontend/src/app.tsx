import { useState, useEffect, useCallback } from 'preact/hooks'
import {
  getAuth, setAuth, clearAuth, probeAuth,
  fetchStats, fetchMessages, fetchChats, fetchContacts, fetchBackfill,
  PAGE_SIZE,
  type AuthConfig, type Stats, type Message, type Chat, type Contact, type BackfillJob,
} from './api'

// ── Icons (inline SVG, zero dependency) ────────────────────────────────────
const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const icons = {
  overview: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 3h7m-3.5-3.5v7',
  search:   'M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z',
  chats:    'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  contacts: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 4v6m3-3h-6',
  backfill: 'M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15',
  logout:   'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v1',
}

type Screen = 'overview' | 'search' | 'chats' | 'contacts' | 'backfill'

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
    { id: 'overview', label: '// overview', icon: 'overview' },
    { id: 'search',   label: '// search',   icon: 'search' },
    { id: 'chats',    label: '// chats',    icon: 'chats' },
    { id: 'contacts', label: '// contacts', icon: 'contacts' },
    { id: 'backfill', label: '// backfill', icon: 'backfill' },
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
function Chats() {
  const [chats, setChats] = useState<Chat[]>([])
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  // Load first page whenever search query changes
  useEffect(() => {
    setLoading(true)
    setError('')
    setOffset(0)
    fetchChats({ name: query || undefined })
      .then(rows => {
        setChats(rows)
        setHasMore(rows.length === PAGE_SIZE)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
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

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>

  return (
    <>
      <PageHeader eyebrow="// chats" title="Indexed Chats">
        <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary)">
          {fmtNum(chats.length)}{hasMore ? '+' : ''} shown
        </span>
      </PageHeader>
      <div class="page-content">
        {error && <div class="form-error">&gt; {error}</div>}
        <div class="search-row">
          <input class="search-input" type="text" placeholder="search chats..."
            value={query} onInput={(e: any) => setQuery(e.target.value)} />
        </div>
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
                  <tr key={c.tg_chat_id}>
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
        {hasMore && (
          <button class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:8px"
            onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <span class="spinner" /> : '// load more'}
          </button>
        )}
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
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  // Load first page whenever search query changes
  useEffect(() => {
    setLoading(true)
    setError('')
    setOffset(0)
    fetchContacts({ search: query || undefined })
      .then(rows => {
        setContacts(rows)
        setHasMore(rows.length === PAGE_SIZE)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
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

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>

  return (
    <>
      <PageHeader eyebrow="// contacts" title="Known Contacts">
        <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-secondary)">
          {fmtNum(contacts.length)}{hasMore ? '+' : ''} shown
        </span>
      </PageHeader>
      <div class="page-content">
        {error && <div class="form-error">&gt; {error}</div>}
        <div class="search-row">
          <input class="search-input" type="text" placeholder="search contacts..."
            value={query} onInput={(e: any) => setQuery(e.target.value)} />
        </div>
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
                : contacts.map(c => (
                  <tr key={c.tg_user_id}>
                    <td>
                      <div style="font-weight:500">{[c.first_name, c.last_name].filter(Boolean).join(' ') || '(unnamed)'}</div>
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
                ))
              }
            </tbody>
          </table>
        </div>
        {hasMore && (
          <button class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:8px"
            onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <span class="spinner" /> : '// load more'}
          </button>
        )}
      </div>
    </>
  )
}

// ── Backfill ─────────────────────────────────────────────────────────────
function Backfill() {
  const [jobs, setJobs] = useState<BackfillJob[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchBackfill()
      .then(r => setJobs(r))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const tabs = ['all', 'pending', 'in_progress', 'complete', 'failed']

  const filtered = jobs.filter(j => filter === 'all' || j.status === filter)

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      pending: 'badge-neutral',
      in_progress: 'badge-accent',
      complete: 'badge-success',
      failed: 'badge-error',
    }
    return map[s] ?? 'badge-neutral'
  }

  if (loading) return <div class="page-content"><div class="empty-state"><span class="spinner" /></div></div>

  return (
    <>
      <PageHeader eyebrow="// backfill" title="Backfill Jobs" />
      <div class="page-content" style="padding-top:0;gap:0">
        <div class="filter-bar">
          {tabs.map(t => (
            <button key={t} class={`filter-tab${filter === t ? ' active' : ''}`} onClick={() => setFilter(t)}>
              {t === 'all' ? '// all' : t.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div style="height:24px" />
        {error && <div class="form-error" style="margin-bottom:16px">&gt; {error}</div>}
        {filtered.length === 0
          ? <div class="empty-state"><div class="empty-state-text">&gt; no jobs</div></div>
          : (
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Chat</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th>Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(j => {
                    const pct = j.total_messages > 0
                      ? Math.round((j.fetched_messages / j.total_messages) * 100)
                      : 0
                    return (
                      <tr key={j.tg_chat_id}>
                        <td>
                          <div style="font-weight:500">{j.chat_name || '(unnamed)'}</div>
                          <div class="muted mono" style="font-size:11px">{j.tg_chat_id}</div>
                        </td>
                        <td><span class={`badge ${statusBadge(j.status)}`}>{j.status.replace('_', ' ')}</span></td>
                        <td style="min-width:160px">
                          <div class="progress-wrap">
                            <div class="progress-bar-bg">
                              <div class="progress-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <div class="progress-label">{pct}%</div>
                          </div>
                        </td>
                        <td class="mono">
                          <span class="accent">{fmtNum(j.fetched_messages)}</span>
                          <span class="muted"> / {fmtNum(j.total_messages)}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </>
  )
}

// ── App ───────────────────────────────────────────────────────────────────
export function App() {
  const [authed, setAuthed] = useState(() => !!getAuth())
  const [screen, setScreen] = useState<Screen>('overview')

  function onLogout() {
    clearAuth()
    setAuthed(false)
  }

  if (!authed) {
    return <Login onAuth={() => setAuthed(true)} />
  }

  const accountId = getAuth()?.accountId ?? 'primary'

  const screens: Record<Screen, any> = {
    overview: Overview,
    search:   Search,
    chats:    Chats,
    contacts: Contacts,
    backfill: Backfill,
  }
  const CurrentScreen = screens[screen]

  return (
    <div class="layout">
      <Sidebar screen={screen} onNav={setScreen} onLogout={onLogout} accountId={accountId} />
      <main class="main">
        <CurrentScreen />
      </main>
    </div>
  )
}
