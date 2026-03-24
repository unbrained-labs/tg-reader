import { useState, useEffect } from 'preact/hooks'
import { fetchStats, fetchMessages, type Stats, type Message } from '../api'
import { PageHeader, fmtNum, fmtTs } from '../shared'

export function Overview() {
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
