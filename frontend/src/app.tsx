import { useState } from 'preact/hooks'
import { getAuth, clearAuth } from './api'
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

  const accountId = getAuth()?.accountId ?? ''

  if (selectedChat) {
    return (
      <div class="layout">
        <Sidebar screen={screen} onNav={onNav} onLogout={onLogout} accountId={accountId} />
        <main class="main">
          <ChatView chat={selectedChat} onBack={() => setSelectedChat(null)} />
        </main>
      </div>
    )
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

  return (
    <div class="layout">
      <Sidebar screen={screen} onNav={onNav} onLogout={onLogout} accountId={accountId} />
      <main class="main">
        {renderScreen()}
      </main>
    </div>
  )
}
