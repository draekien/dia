import { PaneError, PermissionUpdate, Question } from '@shared/domain/attention'
import { OutgoingMessage } from '@shared/domain/message-queue'
import { ConversationMessage, PermissionMode, SessionId } from '@shared/domain/pane'
import { SlashCommandInfo } from '@shared/domain/slash-command'
import { Schema } from 'effect'

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)

/** Emitted by a pane's agent session when the agent has produced a complete conversation message. */
export const AssistantMessageReceived = Schema.TaggedStruct('AssistantMessageReceived', {
  message: ConversationMessage
})
/** Emitted by a pane's agent session for each incremental chunk of assistant text as it streams in. */
export const AssistantTextDelta = Schema.TaggedStruct('AssistantTextDelta', {
  text: Schema.String
})
/** Emitted by a pane's agent session for each incremental chunk of the assistant's extended-thinking text as it streams in, before the answer text. */
export const AssistantThinkingDelta = Schema.TaggedStruct('AssistantThinkingDelta', {
  text: Schema.String
})
/** Emitted by a pane's agent session when the agent begins invoking a tool. */
export const ToolCallStarted = Schema.TaggedStruct('ToolCallStarted', {
  toolCallId: Schema.String,
  toolName: Schema.String
})
/** Emitted by a pane's agent session once a tool invocation has finished, including the input it was called with, the `output` it produced (flattened to text; empty when the turn ended before a result arrived), and `isError` flagging a failed/denied result. */
export const ToolCallCompleted = Schema.TaggedStruct('ToolCallCompleted', {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  output: Schema.String,
  isError: Schema.Boolean
})
/** Emitted by a pane's agent session when the agent needs the user to approve or deny a tool call. `suggestions`, when present, are the SDK's offered "always allow" rules for this call. The renderer's reply should be with a `ResolvePermission` message carrying the same `requestId`. */
export const PermissionRequested = Schema.TaggedStruct('PermissionRequested', {
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  suggestions: Schema.optional(Schema.Array(PermissionUpdate))
})
/** Emitted by a pane's agent session when the agent calls `AskUserQuestion` and needs the user to answer. The renderer's reply should be with a `ResolveQuestion` message carrying the same `requestId`. */
export const QuestionRequested = Schema.TaggedStruct('QuestionRequested', {
  requestId: Schema.String,
  questions: Schema.Array(Question)
})
/** Emitted by a pane's agent session when the agent (in `plan` mode) calls `ExitPlanMode`, carrying the proposed `plan` text. The renderer's reply should be with a `ResolvePlanReview` message carrying the same `requestId`. */
export const PlanReviewRequested = Schema.TaggedStruct('PlanReviewRequested', {
  requestId: Schema.String,
  plan: Schema.String
})
/** Emitted by a pane's agent session when the pane's permission mode changed on its own (a plan was approved, so the mode held before entering plan was restored), so the Host can persist it and reflect it in the layout. User-initiated mode changes do not emit this — the Host already knows those. */
export const PermissionModeChanged = Schema.TaggedStruct('PermissionModeChanged', {
  mode: PermissionMode
})
/** Emitted by a pane's agent session when the agent's current turn has finished successfully. */
export const TurnCompleted = Schema.TaggedStruct('TurnCompleted', {})
/** Emitted by a pane's agent session when the agent's current turn has failed. */
export const TurnErrored = Schema.TaggedStruct('TurnErrored', { error: PaneError })
/** Emitted by a pane's agent session once the Agent SDK session has started (or resumed), carrying the `sessionId` the Host persists so the pane can later be resumed. */
export const SessionStarted = Schema.TaggedStruct('SessionStarted', {
  sessionId: SessionId
})
/** Emitted by a pane's agent session when the slash-command warm-up begins (`active` true, emitted right after the session's `query()` is created, before the `supportedCommands()` result is known) and again if that warm-up fails without producing a list (`active` false, so the renderer can stop showing a warming indicator without wrongly clearing an already-known command list). A successful warm-up ends the warming state by emitting `SlashCommandsAvailable` instead. */
export const SlashCommandsWarming = Schema.TaggedStruct('SlashCommandsWarming', {
  active: Schema.Boolean
})
/** Emitted by a pane's agent session with the slash commands available in the session, so the renderer can offer them in the `/` popover. Emitted once at session start from a `query.supportedCommands()` warm-up (names plus descriptions and argument hints, so the popover is populated before the user's first turn) and again whenever a `commands_changed` message reports a mid-session change. Each list is the complete, replacement set, and receipt ends any warming state signalled by `SlashCommandsWarming`. */
export const SlashCommandsAvailable = Schema.TaggedStruct('SlashCommandsAvailable', {
  commands: Schema.Array(SlashCommandInfo)
})
/** Emitted by a pane's agent session when the agent's context was compacted (e.g. the user ran `/compact`), so the renderer can mark the boundary in the transcript. `preTokens`/`postTokens` bracket the compaction; `trigger` distinguishes a manual `/compact` from an automatic one. */
export const ConversationCompacted = Schema.TaggedStruct('ConversationCompacted', {
  trigger: Schema.Literals(['manual', 'auto']),
  preTokens: Schema.Number,
  postTokens: Schema.optional(Schema.Number)
})
/** Emitted by a pane's agent session when the session's conversation was reset to empty (e.g. the user ran `/clear`), carrying the `newSessionId` the Host must persist in place of the prior one so a later resume continues the fresh conversation rather than the cleared transcript. */
export const ConversationReset = Schema.TaggedStruct('ConversationReset', {
  newSessionId: SessionId
})
/** Emitted by a pane's agent session once per user turn, carrying the turn's `messageUuid` (the file-checkpoint id for Agent SDK `rewindFiles`) and, when a prior assistant turn exists, `resumeAnchorUuid` — the *assistant* message uuid `resumeSessionAt` must branch at to resume the conversation up to and including that reply, excluding this turn and everything after it. `resumeAnchorUuid` is absent when this is the first turn of the conversation (rewinding it means starting a fresh, unresumed session). The Host forwards this so a "rewind to here" affordance can be anchored to the turn. Emitted only when file checkpointing is enabled (the UUID comes from replayed user messages). */
export const CheckpointAvailable = Schema.TaggedStruct('CheckpointAvailable', {
  messageUuid: Schema.String,
  resumeAnchorUuid: Schema.optional(Schema.String)
})
/** Emitted by a pane's agent session after a `RewindToCheckpoint` completes successfully, carrying the `messageUuid` that was rewound to. The pane's files and conversation are now branched at that turn; the forked session's new id arrives separately via `SessionStarted`. The Host forwards this so the renderer can truncate the displayed transcript at that turn. */
export const RewoundToCheckpoint = Schema.TaggedStruct('RewoundToCheckpoint', {
  messageUuid: Schema.String
})
/** Emitted by a pane's agent session whenever its message queue changes, carrying the whole queue in send order. `held` is true when the queue waits for the next user send instead of the next turn end. */
export const MessageQueueChanged = Schema.TaggedStruct('MessageQueueChanged', {
  queued: Schema.Array(OutgoingMessage),
  held: Schema.Boolean
})
/** Emitted by a pane's agent session when it gives `messages` to the agent as one turn, in order. The renderer adds each to the transcript as a user turn; the Host clears the pane's attention. */
export const UserMessagesSent = Schema.TaggedStruct('UserMessagesSent', {
  messages: Schema.Array(OutgoingMessage)
})

/** The full set of events a pane's agent session may emit. Match on `_tag` to translate each into renderer events and attention transitions. */
export const OutboundMessage = Schema.Union([
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
  ConversationReset,
  CheckpointAvailable,
  RewoundToCheckpoint,
  MessageQueueChanged,
  UserMessagesSent
])
export type OutboundMessage = typeof OutboundMessage.Type
