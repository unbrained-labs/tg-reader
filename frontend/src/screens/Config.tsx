import { useState, useEffect } from 'preact/hooks'
import {
  fetchGlobalConfig, fetchChatsConfig, fetchBackfill, setGlobalConfig, updateChatConfig,
  type GlobalConfig, type ChatConfig, type BackfillJob,
} from '../api'
import { PageHeader, fmtNum, fmtTs } from '../shared'

export function Config() {
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
