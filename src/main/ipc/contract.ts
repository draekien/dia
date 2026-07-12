import { Schema } from 'effect'
import { ConversationMessage } from '../domain/pane'
import { PaneNode } from '../domain/pane-tree'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const CHANNEL = {
  command: 'dia:command',
  event: 'dia:event',
  getInitialLayout: 'dia:getInitialLayout'
} as const

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

// Additional commands (FocusPane) join this union in later bullets.
export const IpcCommand = Schema.Union(SendMessage, ResolvePermission, SplitPane, ClosePane)
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

// Additional events (PaneAttentionChanged, PaneClosed) join this union in later bullets.
export const IpcEvent = Schema.Union(
  PaneMessageAppended,
  PaneAssistantTextDelta,
  PaneToolCallStarted,
  PaneToolCallCompleted,
  PanePermissionRequested,
  LayoutChanged
)
export type IpcEvent = typeof IpcEvent.Type
