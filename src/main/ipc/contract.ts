import { Schema } from 'effect'
import { ConversationMessage } from '../domain/pane'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const CHANNEL = {
  command: 'dia:command',
  event: 'dia:event'
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

// Additional commands (SplitPane, ClosePane, FocusPane) join this
// union in later bullets.
export const IpcCommand = Schema.Union(SendMessage, ResolvePermission)
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

// Additional events (LayoutChanged, PaneAttentionChanged, PaneClosed) join this
// union in later bullets.
export const IpcEvent = Schema.Union(
  PaneMessageAppended,
  PaneAssistantTextDelta,
  PaneToolCallStarted,
  PaneToolCallCompleted,
  PanePermissionRequested
)
export type IpcEvent = typeof IpcEvent.Type
