import { Schema } from 'effect'
import { ConversationMessage, PaneConfig } from '../domain/pane'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const InitMessage = Schema.TaggedStruct('Init', { config: PaneConfig })
export const SendText = Schema.TaggedStruct('SendText', { text: Schema.String })
export const ResolvePermission = Schema.TaggedStruct('ResolvePermission', {
  requestId: Schema.String,
  decision: Schema.Literal('allow', 'deny'),
  message: Schema.optional(Schema.String)
})
export const InboundMessage = Schema.Union(InitMessage, SendText, ResolvePermission)
export type InboundMessage = typeof InboundMessage.Type

export const AssistantMessageReceived = Schema.TaggedStruct('AssistantMessageReceived', {
  message: ConversationMessage
})
export const AssistantTextDelta = Schema.TaggedStruct('AssistantTextDelta', {
  text: Schema.String
})
export const ToolCallStarted = Schema.TaggedStruct('ToolCallStarted', {
  toolCallId: Schema.String,
  toolName: Schema.String
})
export const ToolCallCompleted = Schema.TaggedStruct('ToolCallCompleted', {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})
export const PermissionRequested = Schema.TaggedStruct('PermissionRequested', {
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})

export const OutboundMessage = Schema.Union(
  AssistantMessageReceived,
  AssistantTextDelta,
  ToolCallStarted,
  ToolCallCompleted,
  PermissionRequested
)
export type OutboundMessage = typeof OutboundMessage.Type
