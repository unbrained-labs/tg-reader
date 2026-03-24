import { useState } from 'preact/hooks'
import { probeAuth, setAuth, type AuthConfig } from './api'

export function Login({ onAuth }: { onAuth: () => void }) {
  const [workerUrl, setWorkerUrl] = useState('')
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: Event) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const cfg: AuthConfig = { workerUrl: workerUrl.trim(), token: token.trim(), accountId: '' }
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
