import { Schema } from 'effect'
import { ConversationMessage } from '../domain/pane'
import { PaneNode } from '../domain/pane-tree'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const CHANNEL = {
  command: 'dia:command',
  event: 'dia:event',
  getInitialLayout: 'dia:getInitialLayout',
  chooseDirectory: 'dia:chooseDirectory'
} as const

export const ChooseDirectoryResult = Schema.NullOr(
  Schema.Struct({
    path: Schema.String,
    isGitRepo: Schema.Boolean
  })
)
export type ChooseDirectoryResult = typeof ChooseDirectoryResult.Type

export const SendMessage = Schema.TaggedStruct('SendMessage', {
  paneId: Schema.UUID,
  text: Schema.String
})
export type SendMessage = typeof SendMessage.Type

export const ResolvePermission = Schema.TaggedStruct('ResolvePermission', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  decision: Schema.Literal('allow', 'deny'),
  message: Schema.optional(Schema.String)
})
export type ResolvePermission = typeof ResolvePermission.Type

export const SplitPane = Schema.TaggedStruct('SplitPane', {
  paneId: Schema.UUID,
  direction: Schema.Literal('row', 'column')
})
export type SplitPane = typeof SplitPane.Type

export const ClosePane = Schema.TaggedStruct('ClosePane', {
  paneId: Schema.UUID
})
export type ClosePane = typeof ClosePane.Type

export const CreatePane = Schema.TaggedStruct('CreatePane', {
  paneId: Schema.UUID,
  cwd: Schema.String,
  model: Schema.String,
  useWorktree: Schema.Boolean
})
export type CreatePane = typeof CreatePane.Type

// Additional commands (FocusPane) join this union in later bullets.
export const IpcCommand = Schema.Union(
  SendMessage,
  ResolvePermission,
  SplitPane,
  ClosePane,
  CreatePane
)
export type IpcCommand = typeof IpcCommand.Type

export const PaneMessageAppended = Schema.TaggedStruct('PaneMessageAppended', {
  paneId: Schema.UUID,
  message: ConversationMessage
})
export type PaneMessageAppended = typeof PaneMessageAppended.Type

export const PaneAssistantTextDelta = Schema.TaggedStruct('PaneAssistantTextDelta', {
  paneId: Schema.UUID,
  text: Schema.String
})
export type PaneAssistantTextDelta = typeof PaneAssistantTextDelta.Type

export const PaneToolCallStarted = Schema.TaggedStruct('PaneToolCallStarted', {
  paneId: Schema.UUID,
  toolCallId: Schema.String,
  toolName: Schema.String
})
export type PaneToolCallStarted = typeof PaneToolCallStarted.Type

export const PaneToolCallCompleted = Schema.TaggedStruct('PaneToolCallCompleted', {
  paneId: Schema.UUID,
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})
export type PaneToolCallCompleted = typeof PaneToolCallCompleted.Type

export const PanePermissionRequested = Schema.TaggedStruct('PanePermissionRequested', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})
export type PanePermissionRequested = typeof PanePermissionRequested.Type

export const LayoutChanged = Schema.TaggedStruct('LayoutChanged', {
  tree: PaneNode
})
export type LayoutChanged = typeof LayoutChanged.Type

export const PaneCreateFailed = Schema.TaggedStruct('PaneCreateFailed', {
  paneId: Schema.UUID,
  reason: Schema.String
})
export type PaneCreateFailed = typeof PaneCreateFailed.Type

// Additional events (PaneAttentionChanged, PaneClosed) join this union in later bullets.
export const IpcEvent = Schema.Union(
  PaneMessageAppended,
  PaneAssistantTextDelta,
  PaneToolCallStarted,
  PaneToolCallCompleted,
  PanePermissionRequested,
  LayoutChanged,
  PaneCreateFailed
)
export type IpcEvent = typeof IpcEvent.Type
