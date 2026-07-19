import {
  PaneError,
  PermissionResponse,
  PermissionUpdate,
  Question,
  QuestionResponse
} from '@shared/domain/attention'
import { ConversationMessage, PaneConfig, PermissionMode, ThinkingLevel } from '@shared/domain/pane'
import { SlashCommandInfo } from '@shared/domain/slash-command'
import { Schema } from 'effect'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** Sent by main to the pane subprocess once at startup to provide the pane's configuration and start its agent session. When `resume` is set, the session continues the prior Agent SDK session with that id instead of starting fresh. */
export const InitMessage = Schema.TaggedStruct('Init', {
  config: PaneConfig,
  resume: Schema.optional(Schema.String)
})
/** Sent by main to the pane subprocess to forward a user-submitted message for the running agent session to process. */
export const SendText = Schema.TaggedStruct('SendText', { text: Schema.String })
/** Sent by main to the pane subprocess when the user changes the pane's thinking level. The new level is applied on the next user turn, which restarts the Agent SDK session (resuming it) so the fresh `query` picks up the new thinking/effort options. */
export const SetThinkingLevel = Schema.TaggedStruct('SetThinkingLevel', {
  level: ThinkingLevel
})
/** Sent by main to the pane subprocess when the user changes the pane's permission mode. Applied live to the running Agent SDK session via `setPermissionMode`, so it affects the next tool call. Switching into `plan` records the pane's prior mode for restoration on plan approval. */
export const SetPermissionMode = Schema.TaggedStruct('SetPermissionMode', {
  mode: PermissionMode
})
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
/** Sent by main to the pane subprocess in response to a `PlanReviewRequested` message. `approved` true allows the agent's `ExitPlanMode` call and restores the mode held before entering plan; false denies it so the pane keeps planning. */
export const ResolvePlanReview = Schema.TaggedStruct('ResolvePlanReview', {
  requestId: Schema.String,
  approved: Schema.Boolean
})
/** The full set of messages main may send to a pane subprocess. Decode inbound IPC payloads against this union before acting on them. */
export const InboundMessage = Schema.Union(
  InitMessage,
  SendText,
  SetThinkingLevel,
  SetPermissionMode,
  ResolvePermission,
  ResolveQuestion,
  ResolvePlanReview
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
/** Sent by the pane subprocess to main for each incremental chunk of the assistant's extended-thinking text as it streams in, before the answer text. */
export const AssistantThinkingDelta = Schema.TaggedStruct('AssistantThinkingDelta', {
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
/** Sent by the pane subprocess to main when the agent (in `plan` mode) calls `ExitPlanMode`, carrying the proposed `plan` text. Main should respond with a `ResolvePlanReview` message carrying the same `requestId`. */
export const PlanReviewRequested = Schema.TaggedStruct('PlanReviewRequested', {
  requestId: Schema.String,
  plan: Schema.String
})
/** Sent by the pane subprocess to main when the pane's permission mode changed on its own (a plan was approved, so the mode held before entering plan was restored), so main can persist it and reflect it in the layout. User-initiated mode changes do not emit this — main already knows those. */
export const PermissionModeChanged = Schema.TaggedStruct('PermissionModeChanged', {
  mode: PermissionMode
})
/** Sent by the pane subprocess to main when the agent's current turn has finished successfully. */
export const TurnCompleted = Schema.TaggedStruct('TurnCompleted', {})
/** Sent by the pane subprocess to main when the agent's current turn has failed. */
export const TurnErrored = Schema.TaggedStruct('TurnErrored', { error: PaneError })
/** Sent by the pane subprocess to main once the Agent SDK session has started (or resumed), carrying the `sessionId` main persists so the pane can later be resumed. */
export const SessionStarted = Schema.TaggedStruct('SessionStarted', {
  sessionId: Schema.String
})
/** Sent by the pane subprocess to main when the slash-command warm-up begins (`active` true, emitted right after the session's `query()` is created, before the `supportedCommands()` result is known) and again if that warm-up fails without producing a list (`active` false, so the renderer can stop showing a warming indicator without wrongly clearing an already-known command list). A successful warm-up ends the warming state by emitting `SlashCommandsAvailable` instead. */
export const SlashCommandsWarming = Schema.TaggedStruct('SlashCommandsWarming', {
  active: Schema.Boolean
})
/** Sent by the pane subprocess to main with the slash commands available in the session, so the renderer can offer them in the `/` popover. Emitted once at session start from a `query.supportedCommands()` warm-up (names plus descriptions and argument hints, so the popover is populated before the user's first turn) and again whenever a `commands_changed` message reports a mid-session change. Each list is the complete, replacement set, and receipt ends any warming state signalled by `SlashCommandsWarming`. */
export const SlashCommandsAvailable = Schema.TaggedStruct('SlashCommandsAvailable', {
  commands: Schema.Array(SlashCommandInfo)
})
/** Sent by the pane subprocess to main when the agent's context was compacted (e.g. the user ran `/compact`), so the renderer can mark the boundary in the transcript. `preTokens`/`postTokens` bracket the compaction; `trigger` distinguishes a manual `/compact` from an automatic one. */
export const ConversationCompacted = Schema.TaggedStruct('ConversationCompacted', {
  trigger: Schema.Literal('manual', 'auto'),
  preTokens: Schema.Number,
  postTokens: Schema.optional(Schema.Number)
})
/** Sent by the pane subprocess to main when the session's conversation was reset to empty (e.g. the user ran `/clear`), carrying the `newSessionId` main must persist in place of the prior one so a later resume continues the fresh conversation rather than the cleared transcript. */
export const ConversationReset = Schema.TaggedStruct('ConversationReset', {
  newSessionId: Schema.String
})

/** The full set of messages a pane subprocess may send to main. Decode outbound IPC payloads against this union before acting on them. */
export const OutboundMessage = Schema.Union(
  AssistantMessageReceived,
  AssistantTextDelta,
  AssistantThinkingDelta,
  ToolCallStarted,
  ToolCallCompleted,
  PermissionRequested,
  QuestionRequested,
  PlanReviewRequested,
  PermissionModeChanged,
  TurnCompleted,
  TurnErrored,
  SessionStarted,
  SlashCommandsWarming,
  SlashCommandsAvailable,
  ConversationCompacted,
  ConversationReset
)
export type OutboundMessage = typeof OutboundMessage.Type
