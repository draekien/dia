import { useAtomSet, useAtomValue } from '@effect/atom-react'
import type { AgentSummary } from '@shared/domain/agent-summary'
import type { PaneId } from '@shared/domain/pane'
import type { Workspace } from '@shared/domain/project'
import type { TranscriptWidth } from '@shared/domain/transcript-width'
import { Option } from 'effect'
import {
  archiveTab,
  cancelNewAgent,
  closePage,
  deleteTab,
  moveProject,
  newAgent,
  openPage,
  openPluginsPage,
  REGISTER_PROJECT_REFUSAL_TEXT,
  registerProject,
  removeProject,
  renameTab,
  resumeParkedAgent,
  revealProject,
  selectTab,
  unarchiveTab
} from './lib/actions'
import type { View } from './lib/view'
import {
  agentSummariesAtom,
  transcriptWidthAtom,
  viewAtom,
  workspaceAtom
} from './lib/workspace-atoms'

export { PluginCallInvalid, PluginNotServing } from '@shared/plugin/messages'
export { PluginBoundary, type PluginFallback } from './components/plugin-boundary'
export { PluginFailed } from './components/plugin-failed'
export { RightPanel } from './components/right-panel'
export { SessionRail } from './components/session-rail'
export * from './components/ui/breadcrumb'
export * from './components/ui/sidebar'
export { addEntry, declareList, useList } from './lib/list-slots'
export { callHost, followHost, type PluginTarget } from './lib/plugin-messages'
export {
  revealRailCard,
  useRailCardShown,
  useRailLayout
} from './lib/session-rail'
export {
  fillSlot,
  MAIN,
  MAIN_HEADER,
  MAIN_TAB,
  ROOT,
  SIDEBAR,
  Slot,
  type SlotName,
  useProvided
} from './lib/slots'
export { useTabOpenedFromNewAgent } from './lib/tab-opened-from-new-agent'
export type { PageKey, View } from './lib/view'

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
  openPage,
  closePage,
  registerProject,
  moveProject,
  renameTab,
  archiveTab,
  deleteTab,
  unarchiveTab,
  resumeParkedAgent,
  removeProject,
  revealProject,
  openPluginsPage
} as const

export {
  emptyPaneChatState,
  isParkNotice,
  lastUserText,
  type MessagePart,
  type PaneChatState,
  type PaneMessage,
  type ToolCallPart
} from '@shared/domain/pane-chat'
export { formatResetTime } from '@shared/format-reset-time'
export { AboutDialog } from './components/about-dialog'
/**
 * Kernel UI, state, hooks and helpers a renderer plugin renders from, so that a plugin file imports
 * no `@renderer/*` path: the agent status dot and its label, shadcn primitives, `cn` to merge class
 * names, and the chat's atoms, hooks and helpers. Chat state lives in the kernel, so a pane's
 * transcript and pending requests survive the chat plugin being unloaded or reloaded.
 */
export { AccountBanner } from './components/account-banner'
export * from './components/avatar'
export * from './components/entity'
export * from './components/figure'
export { InstallNotice } from './components/install-notice'
export * from './components/list'
export * from './components/meter'
export {
  OPEN_COMMAND_PALETTE_EVENT,
  openCommandPalette
} from './components/open-command-palette'
export { PermissionModeItems } from './components/permission-mode-items'
export * from './components/preview-card'
export * from './components/relative-time'
export {
  CLAUDE_CODE_SETTINGS,
  OPEN_SETTINGS_EVENT,
  openSettings,
  type SettingsLocation
} from './components/settings/open-settings'
export { SettingsRow, SettingsSectionHeading } from './components/settings-section'
export * from './components/status'
export { StatusIndicator, statusLabel } from './components/status-indicator'
export { StepStatusIcon, showsSetup, TabSetupSteps } from './components/tab-setup-steps'
export * from './components/table'
export { useTheme } from './components/theme-provider'
export { TranscriptWidthToggle } from './components/transcript-width-toggle'
export * from './components/ui/alert-dialog'
export * from './components/ui/attachment'
export * from './components/ui/bubble'
export * from './components/ui/button'
export * from './components/ui/checkbox'
export * from './components/ui/command'
export * from './components/ui/context-menu'
export * from './components/ui/dialog'
export * from './components/ui/dropdown-menu'
export * from './components/ui/empty'
export * from './components/ui/input'
export * from './components/ui/input-group'
export * from './components/ui/item'
export * from './components/ui/label'
export * from './components/ui/marker'
export * from './components/ui/message'
export * from './components/ui/popover'
export * from './components/ui/questionnaire'
export * from './components/ui/scroll-area'
export * from './components/ui/select'
export * from './components/ui/separator'
export * from './components/ui/skeleton'
export * from './components/ui/switch'
export * from './components/ui/textarea'
export * from './components/ui/toast'
export * from './components/ui/toggle-group'
export * from './components/ui/tooltip'
export { WorkspaceProblemsBanner } from './components/workspace-problems'
export { useActivities } from './hooks/use-activities'
export { type AdapterStatusJson, useAdapterStatus } from './hooks/use-adapter-status'
export { useAttachmentTypes } from './hooks/use-attachment-types'
export { useDisabledPermissionModes } from './hooks/use-disabled-permission-modes'
export { type ModelCatalog, useModelCatalog } from './hooks/use-model-catalog'
export { useModelPreferences } from './hooks/use-model-preferences'
export { usePluginList } from './hooks/use-plugin-list'
export { type OverrideRejection, usePlugins } from './hooks/use-plugins'
export { awaitsUser } from './lib/account-banner'
export { formatWhen } from './lib/format-when'
export { initials } from './lib/initials'
export { findModelOption } from './lib/model-options'
export {
  paneChatAtom,
  paneEditQueuedAtom,
  paneInterruptAtom,
  paneRemoveQueuedAtom,
  paneRewindAtom,
  paneSendAtom,
  paneSendQueuedNowAtom
} from './lib/pane-chat-atoms'
export {
  type RewindCommand,
  type RewindProgress,
  type RewindRowState,
  type RewindTarget,
  rewindRowState,
  rewindTargets
} from './lib/pane-rewind'
export {
  CREATE_PERMISSION_MODE_OPTIONS,
  disabledPermissionModesFor,
  offeredPermissionModes,
  PERMISSION_MODE_OPTIONS,
  permissionModeLabel
} from './lib/permission-modes'
export { pluginStatusLabel } from './lib/plugin-status-label'
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
export { usageLimitResumeAtom } from './lib/usage-limit-resume-atom'
export { cn } from './lib/utils'
export { REGISTER_PROJECT_REFUSAL_TEXT }
