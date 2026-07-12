import { useEffect, useState } from 'react'
import PaneTreeView from './components/pane-tree-view'
import type { PaneNode } from './dia'

function App() {
  const [tree, setTree] = useState<PaneNode | null>(null)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)

  useEffect(() => {
    window.dia.getInitialLayout().then(setTree)
    return window.dia.onLayoutChanged((event) => setTree(event.tree))
  }, [])

  if (tree === null) return null

  return (
    <div className="h-screen bg-neutral-950">
      <PaneTreeView node={tree} focusedPaneId={focusedPaneId} onFocusPane={setFocusedPaneId} />
    </div>
  )
}

export default App
