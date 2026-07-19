import type { PaneNode } from '@shared/domain/pane-tree'
import { useCallback, useEffect, useState } from 'react'
import { AppHeader } from './components/app-header'
import PaneTreeView from './components/pane-tree-view'

function App() {
  const [tree, setTree] = useState<PaneNode | null>(null)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)

  useEffect(() => {
    window.dia.getInitialLayout().then(setTree)
    return window.dia.onLayoutChanged((event) => setTree(event.tree))
  }, [])

  const handleFocusPane = useCallback((paneId: string) => {
    setFocusedPaneId(paneId)
    window.dia.focusPane(paneId)
  }, [])

  if (tree === null) return null

  return (
    <div className="flex h-screen flex-col bg-background">
      <AppHeader />
      <div className="min-h-0 flex-1">
        <PaneTreeView node={tree} focusedPaneId={focusedPaneId} onFocusPane={handleFocusPane} />
      </div>
    </div>
  )
}

export default App
