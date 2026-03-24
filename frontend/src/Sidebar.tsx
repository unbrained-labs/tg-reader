import { useState } from 'preact/hooks'
import { Icon, icons, type Screen } from './shared'
import type { Account } from './api'

export function Sidebar({ screen, onNav, onLogout, accountId, accounts, onSwitchAccount }: {
  screen: Screen
  onNav: (s: Screen) => void
  onLogout: () => void
  accountId: string
  accounts: Account[]
  onSwitchAccount: (id: string) => void
}) {
  const [showSwitcher, setShowSwitcher] = useState(false)
  const navItems: Array<{ id: Screen; label: string; icon: keyof typeof icons }> = [
    { id: 'overview',   label: '// overview',   icon: 'overview' },
    { id: 'search',     label: '// search',     icon: 'search' },
    { id: 'chats',      label: '// chats',      icon: 'chats' },
    { id: 'contacts',   label: '// contacts',   icon: 'contacts' },
    { id: 'automation', label: '// automation', icon: 'automation' },
    { id: 'tokens',     label: '// tokens',     icon: 'tokens' },
    { id: 'config',     label: '// config',     icon: 'config' },
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
      <div class="sidebar-bottom" style="flex-direction:column;align-items:stretch;gap:6px">
        {showSwitcher && accounts.length > 1 && (
          <div style="display:flex;flex-direction:column;gap:2px">
            {accounts.map(a => (
              <button
                key={a.account_id}
                class={`btn btn-ghost${a.account_id === accountId ? ' active' : ''}`}
                style="font-size:11px;padding:4px 8px;text-align:left;justify-content:flex-start"
                onClick={() => { onSwitchAccount(a.account_id); setShowSwitcher(false) }}
              >
                {a.username ? `@${a.username}` : a.account_id}
              </button>
            ))}
          </div>
        )}
        <div style="display:flex;align-items:center;gap:6px">
          <Icon d={icons.logout} size={14} />
          <span
            class="sidebar-account"
            style={`flex:1;${accounts.length > 1 ? 'cursor:pointer' : ''}`}
            title={accountId}
            onClick={() => accounts.length > 1 && setShowSwitcher(v => !v)}
          >
            {accounts.find(a => a.account_id === accountId)?.username
              ? `@${accounts.find(a => a.account_id === accountId)!.username}`
              : accountId}
          </span>
          <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onClick={onLogout}>
            out
          </button>
        </div>
      </div>
    </aside>
  )
}
