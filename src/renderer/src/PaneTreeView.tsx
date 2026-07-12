import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from '@renderer/components/ui/resizable'
import { Fragment } from 'react'
import type { PaneNode } from './dia'
import Pane from './Pane'
import PaneCreationForm from './PaneCreationForm'

interface PaneTreeViewProps {
  node: PaneNode
}

function PaneTreeView({ node }: PaneTreeViewProps) {
  if (node._tag === 'Leaf') {
    return node.status === 'pending' ? (
      <PaneCreationForm paneId={node.paneId} />
    ) : (
      <Pane paneId={node.paneId} />
    )
  }

  return (
    <ResizablePanelGroup orientation={node.direction === 'row' ? 'horizontal' : 'vertical'}>
      {node.children.map((child, index) => (
        <Fragment key={child._tag === 'Leaf' ? child.paneId : index}>
          {index > 0 && <ResizableHandle withHandle />}
          <ResizablePanel defaultSize={`${(node.sizes[index] ?? 1 / node.children.length) * 100}%`}>
            <PaneTreeView node={child} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  )
}

export default PaneTreeView
