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

export * from './components/ui/sidebar'
export {
  fillSlot,
  MAIN,
  MAIN_HEADER,
  MAIN_TAB,
  ROOT,
  SIDEBAR,
  Slot,
  type SlotName
} from './lib/slots'
export { useTabOpenedFromNewAgent } from './lib/tab-opened-from-new-agent'
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
 * Kernel UI, state, hooks and helpers a renderer plugin renders from, so that a plugin file imports
 * no `@renderer/*` path: the agent status dot and its label, shadcn primitives, `cn` to merge class
 * names, and the chat's atoms, hooks and helpers. Chat state lives in the kernel, so a pane's
 * transcript and pending requests survive the chat plugin being unloaded or reloaded.
 */
export { InstallNotice } from './components/install-notice'
export { PermissionModeItems } from './components/permission-mode-items'
export { openSettings } from './components/settings/open-settings'
export { StatusIndicator, statusLabel } from './components/status-indicator'
export * from './components/ui/alert-dialog'
export * from './components/ui/bubble'
export * from './components/ui/button'
export * from './components/ui/checkbox'
export * from './components/ui/context-menu'
export * from './components/ui/dialog'
export * from './components/ui/input'
export * from './components/ui/input-group'
export * from './components/ui/label'
export * from './components/ui/marker'
export * from './components/ui/message'
export * from './components/ui/popover'
export * from './components/ui/radio-group'
export * from './components/ui/scroll-area'
export * from './components/ui/select'
export * from './components/ui/separator'
export * from './components/ui/switch'
export * from './components/ui/textarea'
export * from './components/ui/tooltip'
export { useAdapterStatus } from './hooks/use-adapter-status'
export { useDisabledPermissionModes } from './hooks/use-disabled-permission-modes'
export { useModelCatalog } from './hooks/use-model-catalog'
export { useModelPreferences } from './hooks/use-model-preferences'
export { findModelOption } from './lib/model-options'
export {
  emptyPaneChatState,
  lastUserText,
  type MessagePart,
  type PaneChatState,
  type PaneMessage,
  type ToolCallPart
} from './lib/pane-chat'
export {
  paneChatAtom,
  paneEditQueuedAtom,
  paneInterruptAtom,
  paneRemoveQueuedAtom,
  paneRewindAtom,
  paneSendAtom
} from './lib/pane-chat-atoms'
export {
  disabledPermissionModesFor,
  offeredPermissionModes,
  PERMISSION_MODE_OPTIONS,
  permissionModeLabel
} from './lib/permission-modes'
export { sendModeAtom, sendModeForEnter } from './lib/send-mode-atom'
export { fitThinkingLevel, thinkingLevelLabel, thinkingLevelsFor } from './lib/thinking-levels'
export { formatElapsed, type TurnActivity, turnActivity } from './lib/turn-activity'
export {
  hasSteps,
  type StepPart,
  type StepsSection,
  sectionDurationMs,
  type TurnBlock,
  turnBlocks
} from './lib/turn-steps'
export { cn } from './lib/utils'
