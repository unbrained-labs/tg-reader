import { useState, useEffect } from 'preact/hooks'
import {
  fetchTokens, revokeToken, createToken, fetchRoles,
  type AgentToken, type Role, type CreateTokenPayload, type TokenAccount,
} from '../api'
import { PageHeader } from '../shared'

export function Tokens() {
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
