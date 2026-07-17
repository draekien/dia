import type { PaneNode } from '@shared/domain/pane-tree'
import { useCallback, useEffect, useState } from 'react'
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
    <div className="h-screen bg-neutral-950">
      <PaneTreeView node={tree} focusedPaneId={focusedPaneId} onFocusPane={handleFocusPane} />
    </div>
  )
}

export default App
