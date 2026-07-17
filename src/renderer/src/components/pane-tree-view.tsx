import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from '@renderer/components/ui/resizable'
import type { PaneNode } from '@shared/domain/pane-tree'
import { Fragment } from 'react'
import Pane from './pane'
import PaneCreationForm from './pane-creation-form'

interface PaneTreeViewProps {
  node: PaneNode
  // True only for the tree's root: a Leaf can only be the workspace's sole pane when it has no
  // siblings, which is exactly the case where it's rendered directly at the root.
  isRoot?: boolean
  focusedPaneId?: string | null
  onFocusPane?: (paneId: string) => void
}

function PaneTreeView({
  node,
  isRoot = true,
  focusedPaneId = null,
  onFocusPane
}: PaneTreeViewProps) {
  if (node._tag === 'Leaf') {
    return node.status === 'pending' ? (
      <PaneCreationForm paneId={node.paneId} isOnlyPane={isRoot} />
    ) : (
      <Pane
        paneId={node.paneId}
        cwd={node.cwd}
        sourceRepo={node.sourceRepo}
        isFocused={focusedPaneId === node.paneId}
        isDimmed={focusedPaneId !== null && focusedPaneId !== node.paneId}
        onFocus={() => onFocusPane?.(node.paneId)}
      />
    )
  }

  return (
    <ResizablePanelGroup orientation={node.direction === 'row' ? 'horizontal' : 'vertical'}>
      {node.children.map((child, index) => (
        <Fragment key={child._tag === 'Leaf' ? child.paneId : index}>
          {index > 0 && <ResizableHandle withHandle />}
          <ResizablePanel defaultSize={`${(node.sizes[index] ?? 1 / node.children.length) * 100}%`}>
            <PaneTreeView
              node={child}
              isRoot={false}
              focusedPaneId={focusedPaneId}
              onFocusPane={onFocusPane}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  )
}

export default PaneTreeView
