import { useState, useEffect } from 'preact/hooks'
import { fetchJobs, toggleJob, createJob, fetchAuditLog, type Job, type AuditEntry, type CreateJobPayload } from '../api'
import { PageHeader, fmtTs } from '../shared'

// ── Cron Builder (for NewJobForm "Custom" preset) ─────────────────────────
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

export function Automation() {
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
