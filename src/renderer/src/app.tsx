import type { PaneNode } from '@shared/domain/pane-tree'
import { useCallback, useEffect, useState } from 'react'
import { AppHeader } from './components/app-header'
import PaneTreeView from './components/pane-tree-view'
import { onPluginsPageRequested, PluginsPage } from './components/plugins-page'

function App() {
  const [tree, setTree] = useState<PaneNode | null>(null)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [pluginsOpen, setPluginsOpen] = useState(false)

  useEffect(() => {
    window.dia.getInitialLayout().then(setTree)
    return window.dia.onLayoutChanged((event) => setTree(event.tree))
  }, [])

  useEffect(() => onPluginsPageRequested(() => setPluginsOpen(true)), [])

  const closePlugins = useCallback(() => setPluginsOpen(false), [])

  const handleFocusPane = useCallback((paneId: string) => {
    setFocusedPaneId(paneId)
    window.dia.focusPane(paneId)
  }, [])

  if (tree === null) return null

  return (
    <div className="flex h-screen flex-col bg-background">
      <AppHeader />
      <div className="min-h-0 flex-1" hidden={pluginsOpen}>
        <PaneTreeView node={tree} focusedPaneId={focusedPaneId} onFocusPane={handleFocusPane} />
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
