import { useState, useEffect, useRef } from 'preact/hooks'
import { fetchContacts, getAuth, type Contact, PAGE_SIZE } from '../api'
import { PageHeader, fmtNum } from '../shared'

export function Contacts() {
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
