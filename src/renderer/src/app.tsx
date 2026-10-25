import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader } from './components/app-header'
import { onPluginsPageRequested, PluginsPage } from './components/plugins-page'
import { NoLayoutPlugin } from './components/tab-content'
import { ROOT, Slot } from './lib/slots'
import { useWorkspace } from './plugin-api'

function App() {
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const workspace = useWorkspace()
  const visibleTab = useRef<string | null>(null)
  const shownBeforePlugins = useRef<string | null>(null)
  const pluginsOpenRef = useRef(false)
  visibleTab.current = workspace?.visibleTab ?? null

  useEffect(
    () =>
      onPluginsPageRequested(() => {
        if (pluginsOpenRef.current) return
        pluginsOpenRef.current = true
        shownBeforePlugins.current = visibleTab.current
        window.dia.selectTab(null)
        setPluginsOpen(true)
      }),
    []
  )

  const closePlugins = useCallback(() => {
    pluginsOpenRef.current = false
    setPluginsOpen(false)
    if (shownBeforePlugins.current !== null) window.dia.selectTab(shownBeforePlugins.current)
  }, [])

  return (
    <div className="flex h-screen flex-col bg-background">
      <AppHeader />
      <div className="min-h-0 flex-1" hidden={pluginsOpen}>
        <Slot name={ROOT} empty={<NoLayoutPlugin />} />
      </div>
      {pluginsOpen ? (
        <div className="min-h-0 flex-1">
          <PluginsPage onClose={closePlugins} />
        </div>
      ) : null}
    </div>
  )
}

export default App
