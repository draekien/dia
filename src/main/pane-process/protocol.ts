import {
  PaneError,
  PermissionResponse,
  PermissionUpdate,
  Question,
  QuestionResponse
} from '@shared/domain/attention'
import { ConversationMessage, PaneConfig } from '@shared/domain/pane'
import { Schema } from 'effect'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** Sent by main to the pane subprocess once at startup to provide the pane's configuration and start its agent session. When `resume` is set, the session continues the prior Agent SDK session with that id instead of starting fresh. */
export const InitMessage = Schema.TaggedStruct('Init', {
  config: PaneConfig,
  resume: Schema.optional(Schema.String)
})
/** Sent by main to the pane subprocess to forward a user-submitted message for the running agent session to process. */
export const SendText = Schema.TaggedStruct('SendText', { text: Schema.String })
/** Sent by main to the pane subprocess in response to a `PermissionRequested` message, carrying the user's `PermissionResponse` for the given `requestId`. */
export const ResolvePermission = Schema.TaggedStruct('ResolvePermission', {
  requestId: Schema.String,
  response: PermissionResponse
})
/** Sent by main to the pane subprocess in response to a `QuestionRequested` message, carrying the user's `QuestionResponse` for the given `requestId`. */
export const ResolveQuestion = Schema.TaggedStruct('ResolveQuestion', {
  requestId: Schema.String,
  response: QuestionResponse
})
/** The full set of messages main may send to a pane subprocess. Decode inbound IPC payloads against this union before acting on them. */
export const InboundMessage = Schema.Union(
  InitMessage,
  SendText,
  ResolvePermission,
  ResolveQuestion
)
export type InboundMessage = typeof InboundMessage.Type

/** Sent by the pane subprocess to main when the agent has produced a complete conversation message. */
export const AssistantMessageReceived = Schema.TaggedStruct('AssistantMessageReceived', {
  message: ConversationMessage
})
/** Sent by the pane subprocess to main for each incremental chunk of assistant text as it streams in. */
export const AssistantTextDelta = Schema.TaggedStruct('AssistantTextDelta', {
  text: Schema.String
})
/** Sent by the pane subprocess to main when the agent begins invoking a tool. */
export const ToolCallStarted = Schema.TaggedStruct('ToolCallStarted', {
  toolCallId: Schema.String,
  toolName: Schema.String
})
/** Sent by the pane subprocess to main once a tool invocation has finished, including the input it was called with, the `output` it produced (flattened to text; empty when the turn ended before a result arrived), and `isError` flagging a failed/denied result. */
export const ToolCallCompleted = Schema.TaggedStruct('ToolCallCompleted', {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  output: Schema.String,
  isError: Schema.Boolean
})
/** Sent by the pane subprocess to main when the agent needs the user to approve or deny a tool call. `suggestions`, when present, are the SDK's offered "always allow" rules for this call. Main should respond with a `ResolvePermission` message carrying the same `requestId`. */
export const PermissionRequested = Schema.TaggedStruct('PermissionRequested', {
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  suggestions: Schema.optional(Schema.Array(PermissionUpdate))
})
/** Sent by the pane subprocess to main when the agent calls `AskUserQuestion` and needs the user to answer. Main should respond with a `ResolveQuestion` message carrying the same `requestId`. */
export const QuestionRequested = Schema.TaggedStruct('QuestionRequested', {
  requestId: Schema.String,
  questions: Schema.Array(Question)
})
/** Sent by the pane subprocess to main when the agent's current turn has finished successfully. */
export const TurnCompleted = Schema.TaggedStruct('TurnCompleted', {})
/** Sent by the pane subprocess to main when the agent's current turn has failed. */
export const TurnErrored = Schema.TaggedStruct('TurnErrored', { error: PaneError })
/** Sent by the pane subprocess to main once the Agent SDK session has started (or resumed), carrying the `sessionId` main persists so the pane can later be resumed. */
export const SessionStarted = Schema.TaggedStruct('SessionStarted', {
  sessionId: Schema.String
})

/** The full set of messages a pane subprocess may send to main. Decode outbound IPC payloads against this union before acting on them. */
export const OutboundMessage = Schema.Union(
  AssistantMessageReceived,
  AssistantTextDelta,
  ToolCallStarted,
  ToolCallCompleted,
  PermissionRequested,
  QuestionRequested,
  TurnCompleted,
  TurnErrored,
  SessionStarted
)
export type OutboundMessage = typeof OutboundMessage.Type
