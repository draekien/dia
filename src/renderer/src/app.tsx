import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader } from './components/app-header'
import { onPluginsPageRequested, PluginsPage } from './components/plugins-page'
import { onSettingsPageRequested, SettingsPage } from './components/settings-page'
import { NoLayoutPlugin } from './components/tab-content'
import { ROOT, Slot } from './lib/slots'
import { useWorkspace } from './plugin-api'

type Page = 'plugins' | 'settings'

function App() {
  const [page, setPage] = useState<Page | null>(null)
  const workspace = useWorkspace()
  const visibleTab = useRef<string | null>(null)
  const shownBeforePage = useRef<string | null>(null)
  const pageRef = useRef<Page | null>(null)
  visibleTab.current = workspace?.visibleTab ?? null

  useEffect(() => {
    const open = (next: Page) => () => {
      if (pageRef.current === null) {
        shownBeforePage.current = visibleTab.current
        window.dia.selectTab(null)
      }
      pageRef.current = next
      setPage(next)
    }
    const stopPlugins = onPluginsPageRequested(open('plugins'))
    const stopSettings = onSettingsPageRequested(open('settings'))
    return () => {
      stopPlugins()
      stopSettings()
    }
  }, [])

  const closePage = useCallback(() => {
    pageRef.current = null
    setPage(null)
    if (shownBeforePage.current !== null) window.dia.selectTab(shownBeforePage.current)
  }, [])

  return (
    <div className="flex h-screen flex-col bg-background">
      <AppHeader />
      <div className="min-h-0 flex-1" hidden={page !== null}>
        <Slot name={ROOT} empty={<NoLayoutPlugin />} />
      </div>
      {page === 'plugins' ? (
        <div className="min-h-0 flex-1">
          <PluginsPage onClose={closePage} />
        </div>
      ) : null}
      {page === 'settings' ? (
        <div className="min-h-0 flex-1">
          <SettingsPage onClose={closePage} />
        </div>
      ) : null}
    </div>
  )
}

export default App
