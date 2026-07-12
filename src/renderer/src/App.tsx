import { useEffect, useState } from 'react'
import type { PaneNode } from './dia'
import PaneTreeView from './PaneTreeView'

function App() {
  const [tree, setTree] = useState<PaneNode | null>(null)

  useEffect(() => {
    window.dia.getInitialLayout().then(setTree)
    return window.dia.onLayoutChanged((event) => setTree(event.tree))
  }, [])

  if (tree === null) return null

  return (
    <div className="h-screen bg-neutral-950">
      <PaneTreeView node={tree} />
    </div>
  )
}

export default App
