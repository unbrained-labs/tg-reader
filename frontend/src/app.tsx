import { useState, useEffect } from 'preact/hooks'
import { getAuth, setAuth, clearAuth, fetchAccounts, type Account } from './api'
import { type Screen } from './shared'
import { Login } from './Login'
import { Sidebar } from './Sidebar'
import { Overview } from './screens/Overview'
import { Search } from './screens/Search'
import { Chats } from './screens/Chats'
import { ChatView } from './screens/ChatView'
import { Contacts } from './screens/Contacts'
import { Automation } from './screens/Automation'
import { Config } from './screens/Config'
import { Tokens } from './screens/Tokens'

export function App() {
  const [authed, setAuthed] = useState(() => !!getAuth())
  const [screen, setScreen] = useState<Screen>('overview')
  const [selectedChat, setSelectedChat] = useState<{ id: string; name: string } | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState(() => getAuth()?.accountId ?? '')

  useEffect(() => {
    if (!authed) return
    fetchAccounts().then(list => {
      setAccounts(list)
      if (!accountId && list.length > 0) switchAccount(list[0].account_id)
    }).catch(() => {})
  }, [authed])

  function switchAccount(id: string) {
    const cfg = getAuth()
    if (!cfg) return
    setAuth({ ...cfg, accountId: id })
    setAccountId(id)
    setScreen('overview')
    setSelectedChat(null)
  }

  function onLogout() {
    clearAuth()
    setAuthed(false)
  }

  function onNav(s: Screen) {
    setScreen(s)
    setSelectedChat(null)
  }

  if (!authed) {
    return <Login onAuth={() => setAuthed(true)} />
  }

  function renderScreen() {
    switch (screen) {
      case 'chats':      return <Chats onSelectChat={(id, name) => setSelectedChat({ id, name })} />
      case 'overview':   return <Overview />
      case 'search':     return <Search />
      case 'contacts':   return <Contacts />
      case 'automation': return <Automation />
      case 'tokens':     return <Tokens />
      case 'config':     return <Config />
    }
  }

  const sidebar = <Sidebar screen={screen} onNav={onNav} onLogout={onLogout} accountId={accountId} accounts={accounts} onSwitchAccount={switchAccount} />

  return (
    <div class="layout">
      {sidebar}
      <main class="main">
        {selectedChat
          ? <ChatView chat={selectedChat} onBack={() => setSelectedChat(null)} />
          : renderScreen()}
      </main>
    </div>
  )
}
