import {
  type AgentEvent,
  capToolOutput,
  MessageUpdated,
  ReasoningUpdated,
  SessionBound,
  ToolCallCompleted,
  ToolCallStarted
} from '@shared/domain/agent-event'
import type { OutgoingMessage } from '@shared/domain/message-queue'
import type { ConversationMessage, SessionId } from '@shared/domain/pane'
import {
  type Cause,
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  type Scope,
  Stream
} from 'effect'
import type { OutboundMessage } from '../session/protocol'
import { AgentEventStore, TranscriptCursor } from './agent-event-store'
import { TranscriptReader } from './transcript-reader'

/** Shortest time between two streaming writes of one reasoning or text item. */
export const STREAMING_WRITE_INTERVAL = Duration.millis(50)

/** What {@link AgentEventRecorder.open} needs to know about the session it records. */
export interface RecordingOptions {
  /** The agent the session belongs to (the pane id). */
  readonly agentId: string
  /** The session's working directory, where its transcript is found. */
  readonly cwd: string
  /** The SDK session the pane resumes, or none for a new conversation. */
  readonly resume: Option.Option<SessionId>
}

/**
 * Service tag for writing a live pane session's conversation to `AgentEventStore`, and keeping the
 * transcript cursor of each session it started at the end of the turns it wrote. Provide it with
 * {@link AgentEventRecorderLive}.
 */
export class AgentEventRecorder extends Context.Service<
  AgentEventRecorder,
  {
    /**
     * Starts recording one pane session. Call it before the session starts. Returns the function
     * to call with every `OutboundMessage` the session emits, in order. Recording lives in the
     * surrounding scope; closing it writes the final state of unfinished items. The returned
     * function never fails: a failed write is logged, and the transcript cursor stops advancing
     * for the rest of the recording.
     */
    readonly open: (
      options: RecordingOptions
    ) => Effect.Effect<(message: OutboundMessage) => Effect.Effect<void>, never, Scope.Scope>
  }
>()('AgentEventRecorder') {}

type Entry = { readonly event: AgentEvent; readonly sourceUuid?: string }

interface StreamingItem {
  readonly itemId: string
  text: string
  lastWriteAt: number
}

interface PendingUser {
  readonly itemId: string
  readonly message: ConversationMessage
}

interface RecordingState {
  reasoning: StreamingItem | undefined
  text: StreamingItem | undefined
  readonly openTools: Map<string, string>
  readonly awaitingCheckpoint: Array<PendingUser>
  boundSession: Option.Option<SessionId>
  ownedSession: Option.Option<SessionId>
  cursorStalled: boolean
}

const reasoningEvent = (item: StreamingItem, streaming: boolean) =>
  ReasoningUpdated.make({ itemId: item.itemId, text: item.text, streaming })

const textEvent = (item: StreamingItem, streaming: boolean) =>
  MessageUpdated.make({
    itemId: item.itemId,
    message: { role: 'assistant', content: item.text },
    streaming
  })

const userMessageOf = (message: OutgoingMessage): ConversationMessage => ({
  role: 'user',
  content: message.text,
  ...(message.attachments !== undefined ? { attachments: message.attachments } : {})
})

const isTurnEnd = (message: OutboundMessage) =>
  message._tag === 'TurnCompleted' ||
  message._tag === 'TurnErrored' ||
  message._tag === 'TurnParked'

const makeRecorder = Effect.gen(function* () {
  const store = yield* AgentEventStore
  const reader = yield* TranscriptReader
  const crypto = yield* Crypto.Crypto

  const newItemId = crypto.randomUUIDv4().pipe(Effect.orDie)

  const nothingFollowsCursor = Effect.fn('AgentEventRecorder.nothingFollowsCursor')(function* (
    sessionId: SessionId,
    cwd: string
  ) {
    const cursor = yield* store.readCursor(sessionId).pipe(
      Effect.tapError((error) =>
        Effect.logWarning('Could not read the transcript cursor', { sessionId, error })
      ),
      Effect.orElseSucceed(() => Option.none<TranscriptCursor>())
    )
    if (Option.isNone(cursor)) return false
    const tail = yield* reader.readTranscriptAfter(
      sessionId,
      cwd,
      Option.some(cursor.value.lastUuid)
    )
    return Option.isSome(tail) && tail.value.entries.length === 0
  })

  const open = Effect.fn('AgentEventRecorder.open')(function* (options: RecordingOptions) {
    const { agentId, cwd } = options
    const ownsResumed = yield* Option.match(options.resume, {
      onNone: () => Effect.succeed(false),
      onSome: (sessionId) => nothingFollowsCursor(sessionId, cwd)
    })
    const state: RecordingState = {
      reasoning: undefined,
      text: undefined,
      openTools: new Map(),
      awaitingCheckpoint: [],
      boundSession: Option.none(),
      ownedSession: ownsResumed ? options.resume : Option.none(),
      cursorStalled: false
    }
    yield* Effect.logDebug('Recording agent events', {
      agentId,
      resume: options.resume,
      ownsCursor: ownsResumed
    })

    const stall = (message: string, context: object) =>
      Effect.gen(function* () {
        state.cursorStalled = true
        yield* Effect.logError(message, { agentId, ...context })
      })

    const append = (entries: ReadonlyArray<Entry>) =>
      entries.length === 0
        ? Effect.void
        : store.append(agentId, entries).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              stall('Could not record agent events; the cursor stops here', {
                events: entries.map(({ event }) => event._tag),
                error
              })
            )
          )

    const advanceCursor = Effect.fn('AgentEventRecorder.advanceCursor')(function* (
      sessionId: SessionId
    ) {
      if (state.cursorStalled) return
      const cursor = yield* store.readCursor(sessionId)
      const tail = yield* reader.readTranscriptAfter(
        sessionId,
        cwd,
        Option.map(cursor, (stored) => stored.lastUuid)
      )
      if (Option.isNone(tail)) return
      const last = tail.value.entries.at(-1)
      if (last === undefined) return
      yield* store.writeCursor(
        TranscriptCursor.make({
          sessionId,
          lastUuid: last.sourceUuid,
          fileSize: tail.value.fileSize,
          mtimeMs: tail.value.mtimeMs
        })
      )
      yield* Effect.logDebug('Advanced the transcript cursor', {
        agentId,
        sessionId,
        lastUuid: last.sourceUuid
      })
    })

    const cursorUpdates = yield* Queue.unbounded<SessionId, Cause.Done>()
    const drain = yield* Effect.forkDetach(
      Stream.runForEach(Stream.fromQueue(cursorUpdates), (sessionId) =>
        advanceCursor(sessionId).pipe(
          Effect.catch((error) =>
            stall('Could not advance the transcript cursor; it stops here', { sessionId, error })
          )
        )
      )
    )

    const offerCursorUpdate = Effect.gen(function* () {
      if (state.cursorStalled || Option.isNone(state.ownedSession)) return
      yield* Queue.offer(cursorUpdates, state.ownedSession.value)
    })

    const closeReasoning = (): ReadonlyArray<Entry> => {
      const item = state.reasoning
      state.reasoning = undefined
      return item === undefined ? [] : [{ event: reasoningEvent(item, false) }]
    }

    const closeText = (): ReadonlyArray<Entry> => {
      const item = state.text
      state.text = undefined
      return item === undefined ? [] : [{ event: textEvent(item, false) }]
    }

    const streamDelta = Effect.fnUntraced(function* (
      current: StreamingItem | undefined,
      delta: string,
      eventOf: (item: StreamingItem, streaming: boolean) => AgentEvent
    ) {
      const now = yield* Clock.currentTimeMillis
      const item = current ?? { itemId: yield* newItemId, text: '', lastWriteAt: -Infinity }
      item.text += delta
      const due = now - item.lastWriteAt >= Duration.toMillis(STREAMING_WRITE_INTERVAL)
      if (due) item.lastWriteAt = now
      return { item, entries: due ? [{ event: eventOf(item, true) }] : [] }
    })

    const bind = (sessionId: SessionId, newConversation: boolean): ReadonlyArray<Entry> => {
      if (Option.contains(state.boundSession, sessionId)) return []
      const firstBind = Option.isNone(state.boundSession)
      state.boundSession = Option.some(sessionId)
      if (newConversation || (firstBind && Option.isNone(options.resume))) {
        state.ownedSession = Option.some(sessionId)
      } else if (!Option.contains(state.ownedSession, sessionId)) {
        state.ownedSession = Option.none()
      }
      return [{ event: SessionBound.make({ sessionId }) }]
    }

    const entriesFor = Effect.fnUntraced(function* (message: OutboundMessage) {
      switch (message._tag) {
        case 'AssistantThinkingDelta': {
          if (message.text === '') return []
          const { item, entries } = yield* streamDelta(
            state.reasoning,
            message.text,
            reasoningEvent
          )
          state.reasoning = item
          return entries
        }
        case 'AssistantTextDelta': {
          if (message.text === '') return []
          const closed = closeReasoning()
          const { item, entries } = yield* streamDelta(state.text, message.text, textEvent)
          state.text = item
          return [...closed, ...entries]
        }
        case 'AssistantMessageReceived': {
          const closed = closeReasoning()
          const itemId = state.text?.itemId ?? (yield* newItemId)
          state.text = undefined
          return [
            ...closed,
            {
              event: MessageUpdated.make({ itemId, message: message.message, streaming: false }),
              sourceUuid: message.sourceId
            }
          ]
        }
        case 'ToolCallStarted': {
          state.openTools.set(message.toolCallId, message.toolName)
          return [
            ...closeReasoning(),
            {
              event: ToolCallStarted.make({
                toolCallId: message.toolCallId,
                toolName: message.toolName
              })
            }
          ]
        }
        case 'ToolCallCompleted': {
          state.openTools.delete(message.toolCallId)
          return [
            ...closeReasoning(),
            {
              event: ToolCallCompleted.make({
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                input: message.input,
                output: capToolOutput(message.output),
                isError: message.isError
              }),
              sourceUuid: message.sourceId
            }
          ]
        }
        case 'UserMessagesSent':
          return message.messages.map((sent): Entry => {
            const pending = { itemId: sent.id, message: userMessageOf(sent) }
            state.awaitingCheckpoint.push(pending)
            return { event: MessageUpdated.make({ ...pending, streaming: false }) }
          })
        case 'CheckpointAvailable': {
          const pending = state.awaitingCheckpoint.shift()
          if (pending === undefined) {
            yield* Effect.logDebug('A checkpoint arrived with no user message awaiting one', {
              agentId,
              messageUuid: message.messageUuid
            })
            return []
          }
          return [
            {
              event: MessageUpdated.make({
                itemId: pending.itemId,
                message: {
                  ...pending.message,
                  checkpointUuid: message.messageUuid,
                  ...(message.resumeAnchorUuid !== undefined
                    ? { resumeAnchorUuid: message.resumeAnchorUuid }
                    : {})
                },
                streaming: false
              }),
              sourceUuid: message.messageUuid
            }
          ]
        }
        case 'SessionStarted':
          return bind(message.sessionId, false)
        case 'ConversationReset':
          return bind(message.newSessionId, true)
        default:
          return isTurnEnd(message) ? [...closeReasoning(), ...closeText()] : []
      }
    })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* offerCursorUpdate
        yield* Queue.end(cursorUpdates)
        yield* Fiber.join(drain)
        yield* Effect.logDebug('Stopped recording agent events', { agentId })
      })
    )
    yield* Effect.addFinalizer(() =>
      append([
        ...closeReasoning(),
        ...closeText(),
        ...Array.from(state.openTools, ([toolCallId, toolName]) => ({
          event: ToolCallCompleted.make({
            toolCallId,
            toolName,
            input: {},
            output: '',
            isError: false
          })
        }))
      ])
    )

    return (message: OutboundMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* append(yield* entriesFor(message))
        if (isTurnEnd(message)) yield* offerCursorUpdate
      })
  })

  return AgentEventRecorder.of({ open })
})

/** The live {@link AgentEventRecorder}. Requires `AgentEventStore`, `TranscriptReader` and `Crypto`. */
export const AgentEventRecorderLive = Layer.effect(AgentEventRecorder, makeRecorder)
