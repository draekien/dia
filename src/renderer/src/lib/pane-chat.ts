import type { AttentionState } from '@shared/domain/attention'
import type { ConversationMessage } from '@shared/domain/pane'
import type {
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneMessageAppended,
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
 * the ordered `parts` that compose it (user turns carry a single text part;
 * assistant turns interleave thinking, text, and tool-call parts).
 */
export interface PaneMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly parts: ReadonlyArray<MessagePart>
}

/**
 * The renderable state of a pane's conversation: the ordered `messages` and
 * whether a turn is currently in flight (`isLoading`). This is the sole
 * contract consumers depend on — how streaming deltas are assembled into it is
 * private to {@link reducePaneChat}.
 */
export interface PaneChatState {
  readonly messages: ReadonlyArray<PaneMessage>
  readonly isLoading: boolean
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

/** The empty conversation state a pane starts from before history loads. */
export const emptyPaneChatState: PaneChatState = { messages: [], isLoading: false }

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
    parts: [{ type: 'text', content: message.content }]
  })),
  isLoading: false
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
  messages: [...state.messages, { id, role: 'user', parts: [{ type: 'text', content: text }] }],
  isLoading: true
})

const lastMessage = (state: PaneChatState): PaneMessage | undefined => state.messages.at(-1)

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
  attention._tag === 'Completed' || attention._tag === 'Errored'

/**
 * Folds one pane stream event into conversation state. Text and thinking deltas
 * extend the in-flight assistant turn; a tool-call start adds a running row and
 * its completion resolves it in place; a terminal attention change (`Completed`
 * or `Errored`) ends the turn. `PaneMessageAppended` is a backstop that only
 * adds a turn's final text when no deltas built it, and user appends are
 * ignored (the optimistic {@link appendUserMessage} already added them). Pure
 * and total — drive a pane's state atom by scanning the IPC stream with it.
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
      return isTurnOver(event.attention) ? { ...state, isLoading: false } : state
  }
}
