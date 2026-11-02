import { Schema } from 'effect'
import { formatResetTime } from '../format-reset-time'
import type {
  IpcEvent,
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneBackgroundTasksChanged,
  PaneCheckpointAvailable,
  PaneCompactionFailed,
  PaneConversationCompacted,
  PaneConversationReset,
  PaneMessageAppended,
  PaneMessageQueueChanged,
  PaneModelChanged,
  PaneRewoundToCheckpoint,
  PaneSessionNotice,
  PaneSetupProgress,
  PaneSlashCommandsAvailable,
  PaneSlashCommandsWarming,
  PaneToolCallCompleted,
  PaneToolCallStarted,
  PaneToolCallUpdated,
  PaneTurnStatusChanged,
  PaneUserMessagesSent
} from '../ipc/contract'
import { Attachment } from './attachment'
import { AttentionState, Idle, isParkedState, type PaneError, type ParkedState } from './attention'
import { BackgroundTask } from './background-task'
import { CompactionFailure } from './context-usage'
import { JsonRecord } from './json-record'
import { OutgoingMessage } from './message-queue'
import type { ConversationMessage } from './pane'
import { RESUME_TEXT } from './parking'
import { SlashCommandInfo } from './slash-command'
import { SetupStep } from './tab-setup'

/** A streamed span of assistant answer text within a turn. */
export const TextPart = Schema.Struct({
  type: Schema.Literal('text'),
  content: Schema.String,
  startedAt: Schema.optional(Schema.Number)
})
export type TextPart = typeof TextPart.Type

/** A streamed span of assistant extended-thinking text, shown collapsed. */
export const ThinkingPart = Schema.Struct({
  type: Schema.Literal('thinking'),
  content: Schema.String,
  startedAt: Schema.optional(Schema.Number)
})
export type ThinkingPart = typeof ThinkingPart.Type

/**
 * One tool invocation in an assistant turn. `running` while in flight; `done`
 * once resolved, at which point `output`/`isError` are populated. `input` is set once it has
 * streamed in, which is before the call runs.
 * `elapsedSeconds` is how long it has run, when the session reported it, and
 * `detail` is a line about it (a subagent's progress, or why it was denied or failed).
 * `endedAt` is when it resolved, in epoch milliseconds, for a live turn.
 */
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal('tool-call'),
  toolCallId: Schema.String,
  name: Schema.String,
  state: Schema.Literals(['running', 'done']),
  input: Schema.optional(JsonRecord),
  output: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  elapsedSeconds: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  endedAt: Schema.optional(Schema.Number)
})
export type ToolCallPart = typeof ToolCallPart.Type

/**
 * The context size before (`preTokens`) and after (`postTokens`, absent when the
 * session did not report it) a context compaction, carried by its `notice`. The
 * view decides how to show the counts.
 */
export const CompactionCounts = Schema.Struct({
  preTokens: Schema.Number,
  postTokens: Schema.optional(Schema.Number)
})
export type CompactionCounts = typeof CompactionCounts.Type

/**
 * An ordered fragment of an assistant turn. Branch on `type` to render. `startedAt` is when the
 * part arrived, in epoch milliseconds; parts restored from history have none.
 */
export const MessagePart = Schema.Union([TextPart, ThinkingPart, ToolCallPart])
export type MessagePart = typeof MessagePart.Type

/**
 * A single rendered conversation turn: a stable pane-scoped `id`, a `role`, and
 * the ordered `parts` that compose it. User turns carry a single text part;
 * assistant turns interleave thinking, text, and tool-call parts; a `notice`
 * turn is a system-generated marker (e.g. a context-compaction divider) with a
 * single text part and no conversational author; a compaction notice also carries
 * its `compaction` counts; an `error` turn is a failed
 * turn's message (its single text part is the error message). Whether an error
 * is retryable is a property of the pane's live attention state (`Errored` is
 * recoverable, `Crashed` is terminal), not of this row. `checkpointUuid`,
 * present only on user turns the
 * pane has confirmed as rewindable, is the Agent SDK message id to pass to
 * `window.dia.rewindToCheckpoint` to restore files and conversation to that
 * point (see ADR-0018). `attachments` are the files a user turn carried; absent means none.
 * `resumeAnchorUuid`, present alongside it when a prior
 * assistant turn exists, is the branch point that rewind resumes from; absent
 * for the first turn. `rewindable` is `false` on the second and later user turns of a batch sent
 * as one turn: a rewind there would also drop the earlier turns of the batch, so the rewind
 * control is hidden for them. It is also `false` on every user turn sent before a context
 * compaction: the compacted session no longer holds those turns, so a rewind to them fails.
 */
export const PaneMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant', 'notice', 'error']),
  parts: Schema.Array(MessagePart),
  attachments: Schema.optional(Schema.Array(Attachment)),
  checkpointUuid: Schema.optional(Schema.String),
  resumeAnchorUuid: Schema.optional(Schema.String),
  rewindable: Schema.optional(Schema.Literal(false)),
  resumedAt: Schema.optional(Schema.Number),
  compaction: Schema.optional(CompactionCounts)
})
export type PaneMessage = typeof PaneMessage.Type

/**
 * The renderable state of a pane's conversation: the ordered `messages`,
 * whether a turn is currently in flight (`isLoading`), the `slashCommands`
 * available in the pane's live session (for the `/` command popover; empty
 * until the session reports them), and `warmingCommands` — true while the
 * session is still discovering that list, so the input can show a "loading
 * commands" indicator. `queued` is the pane's message queue as the Host last reported it, in send
 * order, and `queueHeld` is true when that queue waits for the next user send instead of the next
 * turn end. `turnStatus` names the state the in-flight turn is in (retrying, compacting,
 * thinking), or is null when it has none worth naming.
 * `compactionFailure` says why the last requested compaction did not run, until the next send or
 * compaction. `backgroundTasks` is the work the agent started that runs outside its turns, empty
 * when none runs. `setup` is the latest list of setup steps the Host reported for a worktree tab
 * being created or resumed, absent until one arrives. `attention` is the pane's latest attention
 * state. This is the sole contract consumers depend on — how
 * streaming deltas are assembled into it is private to {@link reducePaneChat}.
 */
export const PaneChatState = Schema.Struct({
  messages: Schema.Array(PaneMessage),
  isLoading: Schema.Boolean,
  slashCommands: Schema.Array(SlashCommandInfo),
  warmingCommands: Schema.Boolean,
  queued: Schema.Array(OutgoingMessage),
  queueHeld: Schema.Boolean,
  turnStatus: Schema.NullOr(Schema.String),
  compactionFailure: Schema.NullOr(CompactionFailure),
  backgroundTasks: Schema.Array(BackgroundTask),
  setup: Schema.optional(Schema.Array(SetupStep)),
  attention: AttentionState
})
export type PaneChatState = typeof PaneChatState.Type

/**
 * A pane's chat state as the Host holds it: `state` after the pane's events numbered 1 to `seq`
 * (the `EventHub` sequence numbers), on top of the transcript the pane was seeded from. Fold only
 * events with a higher `seq` onto it.
 */
export const PaneChatSnapshot = Schema.Struct({
  state: PaneChatState,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type PaneChatSnapshot = typeof PaneChatSnapshot.Type

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
  | PaneToolCallUpdated
  | PaneTurnStatusChanged
  | PaneSessionNotice
  | PaneSetupProgress
  | PaneBackgroundTasksChanged
  | PaneMessageAppended
  | PaneAttentionChanged
  | PaneSlashCommandsWarming
  | PaneSlashCommandsAvailable
  | PaneConversationCompacted
  | PaneCompactionFailed
  | PaneConversationReset
  | PaneCheckpointAvailable
  | PaneRewoundToCheckpoint
  | PaneMessageQueueChanged
  | PaneUserMessagesSent
  | PaneModelChangeNotice

/**
 * A `PaneModelChanged` event with the `displayName` of its model, when the model list has it.
 * Build it where the model list is known; {@link reducePaneChat} shows the raw id without it.
 */
export type PaneModelChangeNotice = PaneModelChanged & { readonly displayName?: string }

const STREAM_EVENT_TAGS: Readonly<Record<PaneStreamEvent['_tag'], true>> = {
  PaneAssistantTextDelta: true,
  PaneAssistantThinkingDelta: true,
  PaneToolCallStarted: true,
  PaneToolCallCompleted: true,
  PaneToolCallUpdated: true,
  PaneTurnStatusChanged: true,
  PaneSessionNotice: true,
  PaneSetupProgress: true,
  PaneBackgroundTasksChanged: true,
  PaneMessageAppended: true,
  PaneAttentionChanged: true,
  PaneSlashCommandsWarming: true,
  PaneSlashCommandsAvailable: true,
  PaneConversationCompacted: true,
  PaneCompactionFailed: true,
  PaneConversationReset: true,
  PaneCheckpointAvailable: true,
  PaneRewoundToCheckpoint: true,
  PaneMessageQueueChanged: true,
  PaneUserMessagesSent: true,
  PaneModelChanged: true
}

/** Whether `event` is one {@link reducePaneChat} folds. */
export const isPaneStreamEvent = (event: IpcEvent): event is PaneStreamEvent =>
  Object.hasOwn(STREAM_EVENT_TAGS, event._tag)

/** The empty conversation state a pane starts from before history loads. */
export const emptyPaneChatState: PaneChatState = {
  messages: [],
  isLoading: false,
  slashCommands: [],
  warmingCommands: false,
  queued: [],
  queueHeld: false,
  turnStatus: null,
  compactionFailure: null,
  backgroundTasks: [],
  attention: Idle.make({})
}

/**
 * Projects a pane's persisted history into initial chat state: each turn
 * becomes a single-text-part message with a stable pane-scoped id, and
 * `isLoading` is false. Use to seed a pane's chat state from its transcript.
 */
export const paneChatStateFromHistory = (
  paneId: string,
  history: ReadonlyArray<ConversationMessage>
): PaneChatState => ({
  ...emptyPaneChatState,
  messages: history.map((message, index) => ({
    id: `${paneId}:history:${index}`,
    role: message.role,
    parts: [{ type: 'text', content: message.content }],
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    ...(message.checkpointUuid !== undefined ? { checkpointUuid: message.checkpointUuid } : {}),
    ...(message.resumeAnchorUuid !== undefined
      ? { resumeAnchorUuid: message.resumeAnchorUuid }
      : {})
  }))
})

// @effect-diagnostics-next-line globalDate:off -- callers that pass no `now` (tests) read the wall clock; the Host and the renderer always pass one.
const wallClock = (): number => Date.now()

const appendSentMessages = (
  state: PaneChatState,
  event: PaneUserMessagesSent,
  now: number | undefined
): PaneChatState => {
  const present = new Set(state.messages.map((message) => message.id))
  const last = state.messages.at(-1)
  const resumesPark =
    last !== undefined &&
    isParkNotice(last) &&
    event.messages.length === 1 &&
    event.messages[0]?.text === RESUME_TEXT
  const sent = event.messages
    .map(
      (message, index): PaneMessage => ({
        id: `${event.paneId}:user:${message.id}`,
        role: 'user',
        parts: [{ type: 'text', content: message.text }],
        ...(message.attachments !== undefined && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
        ...(index > 0 ? { rewindable: false as const } : {}),
        ...(resumesPark ? { resumedAt: now ?? wallClock() } : {})
      })
    )
    .filter((message) => !present.has(message.id))
  return {
    ...state,
    messages: [...resolveParkNotice(state.messages), ...sent],
    isLoading: true,
    turnStatus: null
  }
}

const lastMessage = (state: PaneChatState): PaneMessage | undefined => state.messages.at(-1)

/**
 * The text of the most recent user turn, or `undefined` when the pane has no
 * user turn yet. Used to populate a resend/retry action after an error. After a
 * batch sent as one turn, it is the text of the batch's last message.
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

const startedAt = (now: number | undefined) => (now === undefined ? {} : { startedAt: now })

const extendTrailingText = (
  parts: ReadonlyArray<MessagePart>,
  delta: string,
  now: number | undefined
): ReadonlyArray<MessagePart> => {
  const last = parts.at(-1)
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { ...last, content: last.content + delta }]
  }
  return [...parts, { type: 'text', content: delta, ...startedAt(now) }]
}

const extendTrailingThinking = (
  parts: ReadonlyArray<MessagePart>,
  delta: string,
  now: number | undefined
): ReadonlyArray<MessagePart> => {
  const last = parts.at(-1)
  if (last?.type === 'thinking') {
    return [...parts.slice(0, -1), { ...last, content: last.content + delta }]
  }
  return [...parts, { type: 'thinking', content: delta, ...startedAt(now) }]
}

const completeToolCall = (
  parts: ReadonlyArray<MessagePart>,
  event: PaneToolCallCompleted,
  now: number | undefined
): ReadonlyArray<MessagePart> =>
  parts.map((part) =>
    part.type === 'tool-call' && part.toolCallId === event.toolCallId
      ? {
          ...part,
          state: 'done',
          input: event.input,
          output: event.output,
          isError: event.isError,
          ...(now === undefined ? {} : { endedAt: now })
        }
      : part
  )

const updateToolCall = (
  parts: ReadonlyArray<MessagePart>,
  event: PaneToolCallUpdated
): ReadonlyArray<MessagePart> =>
  parts.map((part) =>
    part.type === 'tool-call' && part.toolCallId === event.toolCallId
      ? {
          ...part,
          ...(event.input !== undefined ? { input: event.input } : {}),
          ...(event.elapsedSeconds !== undefined ? { elapsedSeconds: event.elapsedSeconds } : {}),
          ...(event.detail !== undefined ? { detail: event.detail } : {})
        }
      : part
  )

const holdsToolCall = (message: PaneMessage, toolCallId: string): boolean =>
  message.parts.some((part) => part.type === 'tool-call' && part.toolCallId === toolCallId)

const withToolCallMessage = (
  state: PaneChatState,
  toolCallId: string,
  update: (parts: ReadonlyArray<MessagePart>) => ReadonlyArray<MessagePart>
): PaneChatState | undefined => {
  const index = state.messages.findIndex((message) => holdsToolCall(message, toolCallId))
  if (index === -1) return undefined
  return {
    ...state,
    messages: state.messages.map((message, at) =>
      at === index ? { ...message, parts: update(message.parts) } : message
    )
  }
}

const isTurnOver = (attention: AttentionState): boolean =>
  attention._tag === 'Completed' || attention._tag === 'Errored' || attention._tag === 'Crashed'

const PARKED_SUFFIX = ':parked'
const RESUMED_SUFFIX = ':resumed'

/** Whether `message` is the transcript notice that says the agent is parked. */
export const isParkNotice = (message: PaneMessage): boolean => message.id.endsWith(PARKED_SUFFIX)

const NOTICE_SEPARATOR = ' · '

const parkNoticeText = (attention: ParkedState, nowMs: number): string => {
  switch (attention._tag) {
    case 'ParkedToResume':
      return `Usage limit reached${NOTICE_SEPARATOR}dia resumes at ${formatResetTime(attention.resumesAt, nowMs)}`
    case 'ParkedUntilReset':
      return `Usage limit reached${NOTICE_SEPARATOR}you can resume at ${formatResetTime(attention.resetsAt, nowMs)}`
  }
  if (attention.cause._tag === 'SignedOut') return 'Claude Code is not signed in'
  return attention.cause.resetsAt === null ? 'Usage limit reached' : 'Usage limit has reset'
}

const resolveParkNotice = (messages: ReadonlyArray<PaneMessage>): ReadonlyArray<PaneMessage> => {
  const last = messages.at(-1)
  if (last === undefined || !isParkNotice(last)) return messages
  const text = last.parts.find((part) => part.type === 'text')?.content ?? ''
  const resolved: PaneMessage = {
    ...last,
    id: `${last.id.slice(0, -PARKED_SUFFIX.length)}${RESUMED_SUFFIX}`,
    parts: [{ type: 'text', content: text.split(NOTICE_SEPARATOR)[0] ?? text }]
  }
  return [...messages.slice(0, -1), resolved]
}

const parkedMessage = (
  state: PaneChatState,
  attention: ParkedState,
  now: number | undefined
): PaneChatState => {
  const last = state.messages.at(-1)
  const kept =
    last !== undefined && isParkNotice(last) ? state.messages.slice(0, -1) : state.messages
  const notice: PaneMessage = {
    id: `${kept.length}${PARKED_SUFFIX}`,
    role: 'notice',
    parts: [{ type: 'text', content: parkNoticeText(attention, now ?? wallClock()) }]
  }
  return { ...state, messages: [...kept, notice], isLoading: false }
}

// Checkpoint uuids arrive after their user turn is already rendered, in the
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
const rewindToCheckpoint = (state: PaneChatState, messageUuid: string): PaneChatState => {
  const anchor = state.messages.findIndex((message) => message.checkpointUuid === messageUuid)
  if (anchor === -1) return { ...state, isLoading: false }
  return { ...state, messages: state.messages.slice(0, anchor), isLoading: false }
}

const noticeMessage = (
  state: PaneChatState,
  content: string,
  extra: Pick<PaneMessage, 'compaction'> = {}
): PaneChatState => ({
  ...state,
  messages: [
    ...state.messages,
    {
      id: `${state.messages.length}:notice`,
      role: 'notice',
      parts: [{ type: 'text', content }],
      ...extra
    }
  ]
})

const compactConversation = (
  state: PaneChatState,
  event: PaneConversationCompacted
): PaneChatState => {
  const compaction: CompactionCounts = {
    preTokens: event.preTokens,
    ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {})
  }
  const messages = state.messages.map((message) =>
    message.role === 'user' ? { ...message, rewindable: false as const } : message
  )
  return noticeMessage({ ...state, messages }, 'Context compacted', { compaction })
}

const foldAttention = (
  state: PaneChatState,
  attention: AttentionState,
  now: number | undefined
): PaneChatState => {
  if (attention._tag === 'Crashed' || attention._tag === 'Errored') {
    return {
      ...state,
      messages: [...state.messages, errorMessage(state, attention.error)],
      isLoading: false,
      ...(attention._tag === 'Crashed' ? { queued: [], queueHeld: false, backgroundTasks: [] } : {})
    }
  }
  if (isParkedState(attention)) return parkedMessage(state, attention, now)
  if (attention._tag === 'Idle') {
    const messages = resolveParkNotice(state.messages)
    return messages === state.messages ? state : { ...state, messages }
  }
  return isTurnOver(attention) ? { ...state, isLoading: false } : state
}

/**
 * Folds one pane stream event into conversation state. Text and thinking deltas
 * extend the in-flight assistant turn; a tool-call start adds a running row and
 * its completion resolves it in place; a terminal attention change ends the
 * turn — `Completed` silently, `Errored`/`Crashed` by appending an `error` turn
 * carrying the failure message so the transcript records it; every attention change replaces
 * `attention`, which a conversation reset keeps. `PaneMessageAppended` is a backstop that only
 * adds a turn's final text when no deltas built it, and user appends are
 * ignored (`PaneUserMessagesSent` adds user turns, one per sent message, and
 * marks the pane loading; a message id already in the transcript is skipped).
 * `PaneMessageQueueChanged` replaces `queued` and `queueHeld`; `Crashed` empties them.
 * `PaneSlashCommandsWarming` toggles the `warmingCommands` indicator, and
 * `PaneSlashCommandsAvailable` replaces the available command list (ending any
 * warming state); a compaction, and a model change (`Model → <name>`), append a `notice`
 * divider; a conversation reset
 * clears the transcript while keeping the available commands and the queue.
 * `PaneCompactionFailed` sets
 * `compactionFailure`, which `PaneUserMessagesSent`, `PaneConversationCompacted` and a reset clear.
 * `PaneCheckpointAvailable` anchors a rewindable checkpoint uuid (and its resume
 * anchor) onto the earliest user turn still lacking one, and
 * `PaneToolCallUpdated` sets a running row's input, elapsed time or detail line, `PaneSessionNotice`
 * appends a `notice` divider, `PaneSetupProgress` replaces `setup`, and `PaneTurnStatusChanged` sets `turnStatus`, which the next
 * `PaneUserMessagesSent` also clears. `PaneBackgroundTasksChanged` replaces `backgroundTasks`; a
 * crash and a rewind empty it, because both end the session's process and its tasks with it.
 * `now`, the event's arrival time in epoch milliseconds, stamps `startedAt` on each new part and
 * `endedAt` on each completed tool call; omit it and parts carry no times.
 * `PaneRewoundToCheckpoint` truncates the transcript back to (and excluding) the
 * turn holding that uuid, ending any in-flight turn. Pure and total — drive a
 * pane's state atom by scanning the IPC stream with it.
 */
export const reducePaneChat = (
  state: PaneChatState,
  event: PaneStreamEvent,
  now?: number
): PaneChatState => {
  switch (event._tag) {
    case 'PaneAssistantThinkingDelta':
      return withStreamingAssistant(state, (parts) =>
        extendTrailingThinking(parts, event.text, now)
      )
    case 'PaneAssistantTextDelta':
      return withStreamingAssistant(state, (parts) => extendTrailingText(parts, event.text, now))
    case 'PaneToolCallStarted':
      return withStreamingAssistant(state, (parts) => [
        ...parts,
        {
          type: 'tool-call',
          toolCallId: event.toolCallId,
          name: event.toolName,
          state: 'running',
          ...startedAt(now)
        }
      ])
    case 'PaneToolCallCompleted':
      return (
        withToolCallMessage(state, event.toolCallId, (parts) =>
          completeToolCall(parts, event, now)
        ) ?? withStreamingAssistant(state, (parts) => completeToolCall(parts, event, now))
      )
    case 'PaneToolCallUpdated':
      if (!state.isLoading) return state
      return (
        withToolCallMessage(state, event.toolCallId, (parts) => updateToolCall(parts, event)) ??
        state
      )
    case 'PaneTurnStatusChanged':
      return { ...state, turnStatus: event.label }
    case 'PaneSessionNotice':
      return noticeMessage(state, event.text)
    case 'PaneSetupProgress':
      return { ...state, setup: event.steps }
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
      return foldAttention({ ...state, attention: event.attention }, event.attention, now)
    case 'PaneSlashCommandsWarming':
      return { ...state, warmingCommands: event.active }
    case 'PaneSlashCommandsAvailable':
      return { ...state, slashCommands: event.commands, warmingCommands: false }
    case 'PaneConversationCompacted':
      return compactConversation({ ...state, compactionFailure: null }, event)
    case 'PaneModelChanged':
      return noticeMessage(state, `Model → ${event.displayName ?? event.model}`)
    case 'PaneConversationReset':
      return {
        ...emptyPaneChatState,
        attention: state.attention,
        slashCommands: state.slashCommands,
        queued: state.queued,
        queueHeld: state.queueHeld,
        backgroundTasks: state.backgroundTasks
      }
    case 'PaneCheckpointAvailable':
      return {
        ...state,
        messages: anchorCheckpoint(state.messages, event.messageUuid, event.resumeAnchorUuid)
      }
    case 'PaneRewoundToCheckpoint':
      return rewindToCheckpoint({ ...state, backgroundTasks: [] }, event.messageUuid)
    case 'PaneBackgroundTasksChanged':
      return { ...state, backgroundTasks: event.tasks }
    case 'PaneCompactionFailed':
      return { ...state, compactionFailure: event.failure }
    case 'PaneMessageQueueChanged':
      return { ...state, queued: event.queued, queueHeld: event.held }
    case 'PaneUserMessagesSent':
      return appendSentMessages({ ...state, compactionFailure: null, setup: undefined }, event, now)
  }
}
