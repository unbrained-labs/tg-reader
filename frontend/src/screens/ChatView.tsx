import { useState, useEffect } from 'preact/hooks'
import { fetchHistory, fetchInsight, getAuth, type Message, type HistoryResult, type ChatInsight } from '../api'
import { PageHeader, fmtTs } from '../shared'

// ── InsightPanel ──────────────────────────────────────────────────────────
function InsightPanel({ insight }: { insight: ChatInsight | null | 'loading' }) {
  const toneColor: Record<string, string> = {
    warm: 'var(--success)',
    neutral: 'var(--text-secondary)',
    professional: 'var(--accent)',
    tense: 'var(--error)',
  }

  return (
    <div style="width:260px;min-width:260px;border-left:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;background:var(--surface)">
      <div style="padding:16px;border-bottom:1px solid var(--border);font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--text-secondary)">
        // insights
      </div>

      {insight === 'loading' && (
        <div style="padding:24px;display:flex;justify-content:center">
          <span class="spinner" />
        </div>
      )}

      {insight === null && (
        <div style="padding:20px;display:flex;flex-direction:column;gap:12px">
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.6">
            No insights generated yet for this chat.
          </div>
          <div style="font-size:11px;color:var(--text-secondary);line-height:1.6;font-family:JetBrains Mono,monospace">
            Set up a nightly insights job in the Automation screen to analyse this conversation automatically.
          </div>
        </div>
      )}

      {insight !== null && insight !== 'loading' && (() => {
        const d = insight.data
        const trendIcon = d.tone_trend === 'improving' ? '↑' : d.tone_trend === 'declining' ? '↓' : '→'
        return (
          <div style="padding:16px;display:flex;flex-direction:column;gap:16px">
            {/* Tone */}
            <div style="display:flex;flex-direction:column;gap:6px">
              <div style="font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-secondary)">Tone</div>
              <div style="display:flex;align-items:center;gap:8px">
                <span style={`font-size:13px;font-weight:600;color:${toneColor[d.tone] ?? 'var(--text-primary)'}`}>{d.tone}</span>
                {d.tone_trend && <span style="font-size:11px;color:var(--text-secondary);font-family:JetBrains Mono,monospace">{trendIcon} {d.tone_trend}</span>}
              </div>
            </div>

            {/* Topics */}
            {d.topics.length > 0 && (
              <div style="display:flex;flex-direction:column;gap:6px">
                <div style="font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-secondary)">Topics</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px">
                  {d.topics.map(t => <span key={t} class="badge badge-neutral" style="font-size:11px">{t}</span>)}
                </div>
              </div>
            )}

            {/* Summary */}
            <div style="display:flex;flex-direction:column;gap:6px">
              <div style="font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-secondary)">Summary</div>
              <div style="font-size:12px;color:var(--text-primary);line-height:1.6">{d.summary}</div>
            </div>

            {/* Relationship arc */}
            {d.relationship_arc && (
              <div style="display:flex;flex-direction:column;gap:6px">
                <div style="font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-secondary)">Arc</div>
                <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;font-style:italic">{d.relationship_arc}</div>
              </div>
            )}

            {/* Follow-up */}
            {d.follow_up && (
              <div style="background:var(--accent-subtle);border:1px solid rgba(240,180,41,.2);padding:10px 12px;font-size:12px;color:var(--accent);line-height:1.5">
                {d.follow_up}
              </div>
            )}

            {/* Unresolved threads */}
            {d.unresolved_threads && d.unresolved_threads.length > 0 && (
              <div style="display:flex;flex-direction:column;gap:6px">
                <div style="font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-secondary)">Unresolved</div>
                {d.unresolved_threads.map((t, i) => (
                  <div key={i} style="font-size:11px;color:var(--text-secondary);line-height:1.5;padding-left:8px;border-left:2px solid var(--border)">
                    {t}
                  </div>
                ))}
              </div>
            )}

            {/* Stats row */}
            <div style="display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--border)">
              {d.initiated_by && (
                <div style="font-size:11px;color:var(--text-secondary);font-family:JetBrains Mono,monospace">
                  initiates: <span style="color:var(--text-primary)">{d.initiated_by}</span>
                </div>
              )}
              {d.avg_response_time_hrs !== undefined && (
                <div style="font-size:11px;color:var(--text-secondary);font-family:JetBrains Mono,monospace">
                  avg reply: <span style="color:var(--text-primary)">{d.avg_response_time_hrs}h</span>
                </div>
              )}
              {d.last_active_days_ago !== undefined && (
                <div style="font-size:11px;color:var(--text-secondary);font-family:JetBrains Mono,monospace">
                  last active: <span style="color:var(--text-primary)">{d.last_active_days_ago === 0 ? 'today' : `${d.last_active_days_ago}d ago`}</span>
                </div>
              )}
            </div>

            {/* Generated at */}
            <div style="font-size:10px;color:var(--text-secondary);font-family:JetBrains Mono,monospace;padding-top:4px">
              generated {new Date(insight.generated_at * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
              {' · '}{insight.model}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ── ChatView ──────────────────────────────────────────────────────────────
type BubbleGroup = { sender_id: string; senderLabel: string; isSelf: boolean; messages: Message[] }

export function ChatView({ chat, onBack }: { chat: { id: string; name: string }; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [nextAfterId, setNextAfterId] = useState<number | null>(null)
  const [nextAfterSentAt, setNextAfterSentAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [insight, setInsight] = useState<ChatInsight | null | 'loading'>('loading')

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

  useEffect(() => {
    setInsight('loading')
    fetchInsight(chat.id)
      .then(r => setInsight(r.insight))
      .catch(() => setInsight(null))
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
      <div style="display:flex;flex:1;overflow:hidden">
        {/* Messages column */}
        <div class="chat-scroll" style="flex:1">
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
        {/* Insights sidebar */}
        <InsightPanel insight={insight} />
      </div>
    </>
  )
}
