import { Schema } from 'effect'
import { JsonRecord } from './json-record'
import { ConversationMessage, SessionId } from './pane'

/** A message in an agent's conversation was created, grew while streaming, or was finalised. `itemId` names the item across its updates. */
export const MessageUpdated = Schema.TaggedStruct('MessageUpdated', {
  itemId: Schema.String,
  message: ConversationMessage,
  streaming: Schema.Boolean
})
export type MessageUpdated = typeof MessageUpdated.Type

/** One span of the agent's extended-thinking text was created, grew, or was finalised. `itemId` names the span across its updates. */
export const ReasoningUpdated = Schema.TaggedStruct('ReasoningUpdated', {
  itemId: Schema.String,
  text: Schema.String,
  streaming: Schema.Boolean
})
export type ReasoningUpdated = typeof ReasoningUpdated.Type

/** The agent began a tool call. The call's item id is `toolCallId`. */
export const ToolCallStarted = Schema.TaggedStruct('ToolCallStarted', {
  toolCallId: Schema.String,
  toolName: Schema.String
})
export type ToolCallStarted = typeof ToolCallStarted.Type

/** A tool call finished, with the input it ran with, its output flattened to text, and whether it failed. */
export const ToolCallCompleted = Schema.TaggedStruct('ToolCallCompleted', {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  output: Schema.String,
  isError: Schema.Boolean
})
export type ToolCallCompleted = typeof ToolCallCompleted.Type

/** The agent's conversation continues in SDK session `sessionId` from this event on (start, `/clear`, compaction, fork). */
export const SessionBound = Schema.TaggedStruct('SessionBound', { sessionId: SessionId })
export type SessionBound = typeof SessionBound.Type

/** The agent was created from the existing SDK session `sessionId`. */
export const AgentImported = Schema.TaggedStruct('AgentImported', { sessionId: SessionId })
export type AgentImported = typeof AgentImported.Type

/** The agent was archived. */
export const AgentArchived = Schema.TaggedStruct('AgentArchived', {})
export type AgentArchived = typeof AgentArchived.Type

/** The agent was unarchived. */
export const AgentUnarchived = Schema.TaggedStruct('AgentUnarchived', {})
export type AgentUnarchived = typeof AgentUnarchived.Type

/** Every event an agent's stream holds, in the provider-neutral shape the Host stores. Match on `_tag`. */
export const AgentEvent = Schema.Union([
  MessageUpdated,
  ReasoningUpdated,
  ToolCallStarted,
  ToolCallCompleted,
  SessionBound,
  AgentImported,
  AgentArchived,
  AgentUnarchived
])
/** An event of an agent's stream; see {@link AgentEvent}. */
export type AgentEvent = typeof AgentEvent.Type

/** A message of an agent's conversation at `position`; `streaming` until its final update. */
export const MessageItem = Schema.TaggedStruct('MessageItem', {
  itemId: Schema.String,
  position: Schema.Int,
  streaming: Schema.Boolean,
  message: ConversationMessage
})
export type MessageItem = typeof MessageItem.Type

/** A span of extended-thinking text at `position`; `streaming` until its final update. */
export const ReasoningItem = Schema.TaggedStruct('ReasoningItem', {
  itemId: Schema.String,
  position: Schema.Int,
  streaming: Schema.Boolean,
  text: Schema.String
})
export type ReasoningItem = typeof ReasoningItem.Type

/** A tool call at `position`: `running` until its `ToolCallCompleted`, after which `input`, `output` and `isError` are present. */
export const ToolCallItem = Schema.TaggedStruct('ToolCallItem', {
  itemId: Schema.String,
  position: Schema.Int,
  running: Schema.Boolean,
  toolName: Schema.String,
  input: Schema.optional(JsonRecord),
  output: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean)
})
export type ToolCallItem = typeof ToolCallItem.Type

/** One rendered item of an agent's conversation. Items are ordered by `position`: 0-based, in the arrival order of each item's first event. Match on `_tag`. */
export const AgentItem = Schema.Union([MessageItem, ReasoningItem, ToolCallItem])
/** An item of an agent's conversation; see {@link AgentItem}. */
export type AgentItem = typeof AgentItem.Type
