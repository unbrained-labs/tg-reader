import { useState, useEffect, useRef } from 'preact/hooks'
import { fetchChats, type Chat, PAGE_SIZE } from '../api'
import { PageHeader, fmtNum, fmtTs, chatTypeBadge } from '../shared'

export function Chats({ onSelectChat }: { onSelectChat: (id: string, name: string) => void }) {
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
