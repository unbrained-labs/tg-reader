import { useState, useCallback } from 'preact/hooks'
import { fetchMessages, type Message } from '../api'
import { PageHeader, fmtNum, fmtTs, chatTypeBadge } from '../shared'

export function Search() {
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
