import { useAtomSet, useAtomValue } from '@effect/atom-react'
import type { AgentSummary } from '@shared/domain/agent-summary'
import type { PaneId } from '@shared/domain/pane'
import type { Workspace } from '@shared/domain/project'
import type { TranscriptWidth } from '@shared/domain/transcript-width'
import { Option } from 'effect'
import {
  cancelNewAgent,
  moveProject,
  newAgent,
  openPluginsPage,
  registerProject,
  removeProject,
  renameTab,
  revealProject,
  selectTab
} from './lib/actions'
import type { View } from './lib/view'
import {
  agentSummariesAtom,
  transcriptWidthAtom,
  viewAtom,
  workspaceAtom
} from './lib/workspace-atoms'

export { fillSlot, MAIN, MAIN_HEADER, ROOT, SIDEBAR, Slot, type SlotName } from './lib/slots'
export type { View } from './lib/view'

/** The workspace (projects, tabs, visible tab); `undefined` until it first loads. */
export function useWorkspace(): Workspace | undefined {
  return Option.getOrUndefined(useAtomValue(workspaceAtom))
}

/** The current summary of every tab, keyed by pane id. */
export function useAgentSummaries(): ReadonlyMap<PaneId, AgentSummary> {
  return useAtomValue(agentSummariesAtom)
}

/** What the content area shows; `undefined` until the workspace loads. */
export function useView(): View | undefined {
  return useAtomValue(viewAtom)
}

/** The app-wide transcript width and a setter that changes and persists it. */
export function useTranscriptWidth(): readonly [TranscriptWidth, (width: TranscriptWidth) => void] {
  return [useAtomValue(transcriptWidthAtom), useAtomSet(transcriptWidthAtom)]
}

/**
 * What a renderer plugin can ask the app to do. Each sends its request to the Host, which answers
 * through the workspace and summaries the hooks above read.
 */
export const actions = {
  selectTab,
  newAgent,
  cancelNewAgent,
  registerProject,
  moveProject,
  renameTab,
  removeProject,
  revealProject,
  openPluginsPage
} as const

/**
 * Kernel UI a renderer plugin renders, so that a plugin file imports no `@renderer/*` path: the
 * agent status dot and its label, the shadcn primitives the sidebar uses, and `cn` to merge
 * class names.
 */
export { StatusIndicator, statusLabel } from './components/status-indicator'
export * from './components/ui/button'
export * from './components/ui/checkbox'
export * from './components/ui/context-menu'
export * from './components/ui/dialog'
export * from './components/ui/input'
export * from './components/ui/popover'
export * from './components/ui/scroll-area'
export * from './components/ui/separator'
export * from './components/ui/tooltip'
export { cn } from './lib/utils'
