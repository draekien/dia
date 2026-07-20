import type { AttentionState, PaneError } from '@shared/domain/attention'
import type { ConversationMessage } from '@shared/domain/pane'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import type {
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneCheckpointAvailable,
  PaneConversationCompacted,
  PaneConversationReset,
  PaneMessageAppended,
  PaneRewoundToCheckpoint,
  PaneSlashCommandsAvailable,
  PaneSlashCommandsWarming,
  PaneToolCallCompleted,
  PaneToolCallStarted
} from '@shared/ipc/contract'

/** A streamed span of assistant answer text within a turn. */
export interface TextPart {
  readonly type: 'text'
  readonly content: string
}

/** A streamed span of assistant extended-thinking text, shown collapsed. */
export interface ThinkingPart {
  readonly type: 'thinking'
  readonly content: string
}

/**
 * One tool invocation in an assistant turn. `running` while in flight; `done`
 * once resolved, at which point `input`/`output`/`isError` are populated.
 */
export interface ToolCallPart {
  readonly type: 'tool-call'
  readonly toolCallId: string
  readonly name: string
  readonly state: 'running' | 'done'
  readonly input?: Record<string, unknown>
  readonly output?: string
  readonly isError?: boolean
}

/** An ordered fragment of an assistant turn. Branch on `type` to render. */
export type MessagePart = TextPart | ThinkingPart | ToolCallPart

/**
 * A single rendered conversation turn: a stable pane-scoped `id`, a `role`, and
 * the ordered `parts` that compose it. User turns carry a single text part;
 * assistant turns interleave thinking, text, and tool-call parts; a `notice`
 * turn is a system-generated marker (e.g. a context-compaction divider) with a
 * single text part and no conversational author; an `error` turn is a failed
 * turn's message (its single text part is the error message). Whether an error
 * is retryable is a property of the pane's live attention state (`Errored` is
 * recoverable, `Crashed` is terminal), not of this row. `checkpointUuid`,
 * present only on user turns the
 * pane has confirmed as rewindable, is the Agent SDK message id to pass to
 * `window.dia.rewindToCheckpoint` to restore files and conversation to that
 * point (see ADR-0018). `resumeAnchorUuid`, present alongside it when a prior
 * assistant turn exists, is the branch point that rewind resumes from; absent
 * for the first turn.
 */
export interface PaneMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'notice' | 'error'
  readonly parts: ReadonlyArray<MessagePart>
  readonly checkpointUuid?: string
  readonly resumeAnchorUuid?: string
}

/**
 * The renderable state of a pane's conversation: the ordered `messages`,
 * whether a turn is currently in flight (`isLoading`), the `slashCommands`
 * available in the pane's live session (for the `/` command popover; empty
 * until the session reports them), and `warmingCommands` — true while the
 * session is still discovering that list, so the input can show a "loading
 * commands" indicator. This is the sole contract consumers depend on — how
 * streaming deltas are assembled into it is private to {@link reducePaneChat}.
 */
export interface PaneChatState {
  readonly messages: ReadonlyArray<PaneMessage>
  readonly isLoading: boolean
  readonly slashCommands: ReadonlyArray<SlashCommandInfo>
  readonly warmingCommands: boolean
}

/**
 * The subset of `IpcEvent`s that drive a pane's conversation state. Feed each
 * to {@link reducePaneChat}; other IPC events (layout, permission, question)
 * are handled elsewhere.
 */
export type PaneStreamEvent =
  | PaneAssistantTextDelta
  | PaneAssistantThinkingDelta
  | PaneToolCallStarted
  | PaneToolCallCompleted
  | PaneMessageAppended
  | PaneAttentionChanged
  | PaneSlashCommandsWarming
  | PaneSlashCommandsAvailable
  | PaneConversationCompacted
  | PaneConversationReset
  | PaneCheckpointAvailable
  | PaneRewoundToCheckpoint

/** The empty conversation state a pane starts from before history loads. */
export const emptyPaneChatState: PaneChatState = {
  messages: [],
  isLoading: false,
  slashCommands: [],
  warmingCommands: false
}

/**
 * Projects a pane's persisted history into initial chat state: each turn
 * becomes a single-text-part message with a stable pane-scoped id, and
 * `isLoading` is false. Use to seed a pane's state atom on first mount.
 */
export const paneChatStateFromHistory = (
  paneId: string,
  history: ReadonlyArray<ConversationMessage>
): PaneChatState => ({
  messages: history.map((message, index) => ({
    id: `${paneId}:history:${index}`,
    role: message.role,
    parts: [{ type: 'text', content: message.content }],
    ...(message.checkpointUuid !== undefined ? { checkpointUuid: message.checkpointUuid } : {}),
    ...(message.resumeAnchorUuid !== undefined
      ? { resumeAnchorUuid: message.resumeAnchorUuid }
      : {})
  })),
  isLoading: false,
  slashCommands: [],
  warmingCommands: false
})

/**
 * Optimistically appends a user turn and marks the pane loading. Call on submit
 * before dispatching the send to the pane process; the assistant reply arrives
 * back through {@link reducePaneChat}. `id` must be stable across re-renders.
 */
export const appendUserMessage = (
  state: PaneChatState,
  id: string,
  text: string
): PaneChatState => ({
  ...state,
  messages: [...state.messages, { id, role: 'user', parts: [{ type: 'text', content: text }] }],
  isLoading: true
})

const lastMessage = (state: PaneChatState): PaneMessage | undefined => state.messages.at(-1)

/**
 * The text of the most recent user turn, or `undefined` when the pane has no
 * user turn yet. Used to populate a resend/retry action after an error.
 */
export const lastUserText = (state: PaneChatState): string | undefined => {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index]
    if (message.role !== 'user') continue
    const text = message.parts.find((part) => part.type === 'text')
    return text?.type === 'text' ? text.content : undefined
  }
  return undefined
}

const errorMessage = (state: PaneChatState, error: PaneError): PaneMessage => ({
  id: `${state.messages.length}:error`,
  role: 'error',
  parts: [{ type: 'text', content: error.message }]
})

// The turn currently being streamed is the trailing assistant message while a turn is in flight;
// once a turn settles (isLoading false) that message is closed and the next event opens a new one.
const isStreamingAssistant = (state: PaneChatState): boolean => {
  const message = lastMessage(state)
  return state.isLoading && message !== undefined && message.role === 'assistant'
}

const replaceLastMessage = (state: PaneChatState, message: PaneMessage): PaneChatState => ({
  ...state,
  messages: [...state.messages.slice(0, -1), message]
})

const withStreamingAssistant = (
  state: PaneChatState,
  update: (parts: ReadonlyArray<MessagePart>) => ReadonlyArray<MessagePart>
): PaneChatState => {
  if (isStreamingAssistant(state)) {
    const message = state.messages[state.messages.length - 1]
    return replaceLastMessage(state, { ...message, parts: update(message.parts) })
  }
  const opened: PaneMessage = {
    id: `${state.messages.length}:assistant`,
    role: 'assistant',
    parts: update([])
  }
  return { ...state, messages: [...state.messages, opened], isLoading: true }
}

const extendTrailingText = (
  parts: ReadonlyArray<MessagePart>,
  delta: string
): ReadonlyArray<MessagePart> => {
  const last = parts.at(-1)
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', content: last.content + delta }]
  }
  return [...parts, { type: 'text', content: delta }]
}

const extendTrailingThinking = (
  parts: ReadonlyArray<MessagePart>,
  delta: string
): ReadonlyArray<MessagePart> => {
  const last = parts.at(-1)
  if (last?.type === 'thinking') {
    return [...parts.slice(0, -1), { type: 'thinking', content: last.content + delta }]
  }
  return [...parts, { type: 'thinking', content: delta }]
}

const completeToolCall = (
  parts: ReadonlyArray<MessagePart>,
  event: PaneToolCallCompleted
): ReadonlyArray<MessagePart> =>
  parts.map((part) =>
    part.type === 'tool-call' && part.toolCallId === event.toolCallId
      ? {
          ...part,
          state: 'done',
          input: event.input,
          output: event.output,
          isError: event.isError
        }
      : part
  )

const isTurnOver = (attention: AttentionState): boolean =>
  attention._tag === 'Completed' || attention._tag === 'Errored' || attention._tag === 'Crashed'

// Checkpoint uuids arrive after their optimistic user turn is already rendered, in the
// same order the turns were submitted, so bind each to the earliest user turn still
// lacking one. Turns restored from history already carry their uuid and are skipped.
// resumeAnchorUuid (the preceding assistant turn) rides along, absent for the first turn.
const anchorCheckpoint = (
  messages: ReadonlyArray<PaneMessage>,
  messageUuid: string,
  resumeAnchorUuid: string | undefined
): ReadonlyArray<PaneMessage> => {
  const target = messages.findIndex(
    (message) => message.role === 'user' && message.checkpointUuid === undefined
  )
  if (target === -1) return messages
  return messages.map((message, index) =>
    index === target
      ? {
          ...message,
          checkpointUuid: messageUuid,
          ...(resumeAnchorUuid !== undefined ? { resumeAnchorUuid } : {})
        }
      : message
  )
}

// Rewind branches the conversation just before the anchored turn, so the displayed
// transcript drops that turn and everything after it (slice ends at, not past, the anchor).
const truncateToCheckpoint = (
  messages: ReadonlyArray<PaneMessage>,
  messageUuid: string
): ReadonlyArray<PaneMessage> => {
  const anchor = messages.findIndex((message) => message.checkpointUuid === messageUuid)
  return anchor === -1 ? messages : messages.slice(0, anchor)
}

const compactionNotice = (event: PaneConversationCompacted): string =>
  event.postTokens !== undefined
    ? `Context compacted — ${event.preTokens} → ${event.postTokens} tokens`
    : 'Context compacted'

/**
 * Folds one pane stream event into conversation state. Text and thinking deltas
 * extend the in-flight assistant turn; a tool-call start adds a running row and
 * its completion resolves it in place; a terminal attention change ends the
 * turn — `Completed` silently, `Errored`/`Crashed` by appending an `error` turn
 * carrying the failure message so the transcript records it. `PaneMessageAppended` is a backstop that only
 * adds a turn's final text when no deltas built it, and user appends are
 * ignored (the optimistic {@link appendUserMessage} already added them).
 * `PaneSlashCommandsWarming` toggles the `warmingCommands` indicator, and
 * `PaneSlashCommandsAvailable` replaces the available command list (ending any
 * warming state); a compaction appends a `notice` divider; a conversation reset
 * clears the transcript while keeping the available commands.
 * `PaneCheckpointAvailable` anchors a rewindable checkpoint uuid (and its resume
 * anchor) onto the earliest user turn still lacking one, and
 * `PaneRewoundToCheckpoint` truncates the transcript back to (and excluding) the
 * turn holding that uuid, ending any in-flight turn. Pure and total — drive a
 * pane's state atom by scanning the IPC stream with it.
 */
export const reducePaneChat = (state: PaneChatState, event: PaneStreamEvent): PaneChatState => {
  switch (event._tag) {
    case 'PaneAssistantThinkingDelta':
      return withStreamingAssistant(state, (parts) => extendTrailingThinking(parts, event.text))
    case 'PaneAssistantTextDelta':
      return withStreamingAssistant(state, (parts) => extendTrailingText(parts, event.text))
    case 'PaneToolCallStarted':
      return withStreamingAssistant(state, (parts) => [
        ...parts,
        { type: 'tool-call', toolCallId: event.toolCallId, name: event.toolName, state: 'running' }
      ])
    case 'PaneToolCallCompleted':
      return withStreamingAssistant(state, (parts) => completeToolCall(parts, event))
    case 'PaneMessageAppended': {
      if (event.message.role !== 'assistant' || isStreamingAssistant(state)) return state
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `${state.messages.length}:assistant`,
            role: 'assistant',
            parts: [{ type: 'text', content: event.message.content }]
          }
        ]
      }
    }
    case 'PaneAttentionChanged':
      if (event.attention._tag === 'Errored' || event.attention._tag === 'Crashed') {
        return {
          ...state,
          messages: [...state.messages, errorMessage(state, event.attention.error)],
          isLoading: false
        }
      }
      return isTurnOver(event.attention) ? { ...state, isLoading: false } : state
    case 'PaneSlashCommandsWarming':
      return { ...state, warmingCommands: event.active }
    case 'PaneSlashCommandsAvailable':
      return { ...state, slashCommands: event.commands, warmingCommands: false }
    case 'PaneConversationCompacted':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `${state.messages.length}:notice`,
            role: 'notice',
            parts: [{ type: 'text', content: compactionNotice(event) }]
          }
        ]
      }
    case 'PaneConversationReset':
      return { ...emptyPaneChatState, slashCommands: state.slashCommands }
    case 'PaneCheckpointAvailable':
      return {
        ...state,
        messages: anchorCheckpoint(state.messages, event.messageUuid, event.resumeAnchorUuid)
      }
    case 'PaneRewoundToCheckpoint':
      return {
        ...state,
        messages: truncateToCheckpoint(state.messages, event.messageUuid),
        isLoading: false
      }
  }
}
