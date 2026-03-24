import { Icon, icons, type Screen } from './shared'

export function Sidebar({ screen, onNav, onLogout, accountId }: {
  screen: Screen
  onNav: (s: Screen) => void
  onLogout: () => void
  accountId: string
}) {
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
      <div class="sidebar-bottom">
        <Icon d={icons.logout} size={14} />
        <span class="sidebar-account" style="flex:1" title={accountId}>{accountId}</span>
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onClick={onLogout}>
          out
        </button>
      </div>
    </aside>
  )
}
