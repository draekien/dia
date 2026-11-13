import {
  type AgentBackend,
  AgentEvents,
  type OutboundMessage,
  type OutgoingMessage,
  type RecordingOptions,
  type SessionId,
  TranscriptCursor
} from '@dia/plugin'
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
  Semaphore,
  Stream
} from 'effect'
import { RunEventStore } from './store'

const {
  ConversationCleared,
  ConversationRewound,
  capToolOutput,
  MessageUpdated,
  ReasoningUpdated,
  SessionBound,
  ToolCallCompleted,
  ToolCallStarted
} = AgentEvents
type AgentEvent = AgentEvents.AgentEvent
type ConversationMessage = AgentEvents.MessageUpdated['message']
type ToolInput = AgentEvents.ToolCallCompleted['input']

/** Shortest time between two streaming writes of one reasoning or text item. */
export const STREAMING_WRITE_INTERVAL = Duration.millis(50)

/**
 * Reads a session's transcript file without starting a session, as the loaded agent backend does.
 * Provide it from the backend `dia-run-events` reads; with no backend, both return none.
 */
export class Transcripts extends Context.Service<
  Transcripts,
  Pick<AgentBackend, 'transcriptInfo' | 'readTranscriptAfter'>
>()('Transcripts') {}

/**
 * Service tag for writing a live pane session's conversation to `RunEventStore`, and keeping the
 * transcript cursor of each session it binds at the end of the turns it wrote. Provide it with
 * {@link RunEventRecorderLive}.
 */
export class RunEventRecorder extends Context.Service<
  RunEventRecorder,
  {
    /**
     * Starts recording one pane session. Call it before the session starts. Returns the function
     * to call with every `OutboundMessage` the session emits, in order. Recording lives in the
     * surrounding scope; closing it writes the final state of unfinished items. The returned
     * function never fails: a failed write is logged, and the transcript cursor stops advancing
     * for the rest of the recording.
     *
     * When `resume` is some, first appends the entries of that session's transcript the run has
     * not stored. A failed catch-up is logged and does not fail `open`. While the pane still
     * resumes that session, the next open retries it; once the pane persists another session id
     * (a fork or a conversation reset), the entries of the failed session are imported only as far
     * as that session's transcript copies them.
     */
    readonly open: (
      options: RecordingOptions
    ) => Effect.Effect<(message: OutboundMessage) => Effect.Effect<void>, never, Scope.Scope>
    /**
     * Appends to run `runId` the entries of SDK session `sessionId`'s transcript (found from
     * `cwd`) that it has not stored, and moves the session's cursor to the transcript's end. Does
     * nothing when the transcript's size and modification time match the cursor. Returns the
     * session when the run now holds every entry up to the cursor, or none when there is no
     * transcript or the catch-up failed; a failure is logged, never raised. Call it before reading
     * a run's history, so turns added outside dia are included.
     */
    readonly catchUp: (options: {
      readonly runId: string
      readonly sessionId: SessionId
      readonly cwd: string
    }) => Effect.Effect<Option.Option<SessionId>>
  }
>()('RunEventRecorder') {}

type Entry = { readonly event: AgentEvent; readonly sourceUuid?: string }

interface StreamingItem {
  readonly itemId: string
  text: string
  writtenText: string
  lastWriteAt: number
  flushScheduled: boolean
}

interface PendingUser {
  readonly itemId: string
  readonly message: ConversationMessage
}

interface OpenTool {
  readonly toolName: string
  input: ToolInput
}

interface RecordingState {
  reasoning: StreamingItem | undefined
  text: StreamingItem | undefined
  readonly openTools: Map<string, OpenTool>
  readonly awaitingCheckpoint: Array<PendingUser>
  boundSession: Option.Option<SessionId>
  ownedSession: Option.Option<SessionId>
  cursorStalled: boolean
  catchUpFailed: boolean
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
  const store = yield* RunEventStore
  const reader = yield* Transcripts
  const crypto = yield* Crypto.Crypto

  const newItemId = crypto.randomUUIDv4().pipe(Effect.orDie)

  const catchUp = Effect.fn('RunEventRecorder.catchUp')(
    function* ({
      runId,
      sessionId,
      cwd
    }: {
      readonly runId: string
      readonly sessionId: SessionId
      readonly cwd: string
    }) {
      const info = yield* reader.transcriptInfo(sessionId, cwd)
      if (Option.isNone(info)) {
        yield* Effect.logWarning('No transcript to catch up from', { runId, sessionId })
        return Option.none<SessionId>()
      }
      const cursor = yield* store.readCursor(sessionId)
      if (
        Option.isSome(cursor) &&
        cursor.value.fileSize === info.value.fileSize &&
        cursor.value.mtimeMs === info.value.mtimeMs
      ) {
        yield* Effect.logDebug('The transcript has not changed since its cursor', {
          runId,
          sessionId
        })
        return Option.some(sessionId)
      }
      const tail = yield* reader.readTranscriptAfter(
        sessionId,
        cwd,
        Option.map(cursor, (stored) => stored.lastUuid)
      )
      if (Option.isNone(tail)) return Option.none<SessionId>()
      yield* store.appendTranscript(runId, sessionId, tail.value)
      yield* Effect.logInfo('Caught up from the transcript', {
        runId,
        sessionId,
        entries: tail.value.entries.length
      })
      return Option.some(sessionId)
    },
    (effect, { runId, sessionId }) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning('Could not catch up from the transcript', {
            runId,
            sessionId,
            error
          }).pipe(Effect.as(Option.none<SessionId>()))
        )
      )
  )

  const open = Effect.fn('RunEventRecorder.open')(function* (options: RecordingOptions) {
    const { runId, cwd } = options
    const caughtUp = yield* Option.match(options.resume, {
      onNone: () => Effect.succeed(Option.none<SessionId>()),
      onSome: (sessionId) => catchUp({ runId, sessionId, cwd })
    })
    const state: RecordingState = {
      reasoning: undefined,
      text: undefined,
      openTools: new Map(),
      awaitingCheckpoint: [],
      boundSession: Option.none(),
      ownedSession: caughtUp,
      cursorStalled: false,
      catchUpFailed: Option.isSome(options.resume) && Option.isNone(caughtUp)
    }
    yield* Effect.logDebug('Recording run events', {
      runId,
      resume: options.resume,
      ownsCursor: Option.isSome(caughtUp)
    })
    const recordingScope = yield* Effect.scope
    const lock = yield* Semaphore.make(1)

    const stall = (message: string, context: object) =>
      Effect.gen(function* () {
        state.cursorStalled = true
        yield* Effect.logError(message, { runId, ...context })
      })

    const append = (entries: ReadonlyArray<Entry>) =>
      entries.length === 0
        ? Effect.void
        : store.append(runId, entries).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              stall('Could not record run events; the cursor stops here', {
                events: entries.map(({ event }) => event._tag),
                error
              })
            )
          )

    const advanceCursor = Effect.fn('RunEventRecorder.advanceCursor')(function* (
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
      const lastUuid =
        tail.value.entries.at(-1)?.sourceUuid ??
        Option.getOrUndefined(Option.map(cursor, (stored) => stored.lastUuid))
      if (lastUuid === undefined) return
      yield* store.writeCursor(
        TranscriptCursor.make({
          sessionId,
          lastUuid,
          fileSize: tail.value.fileSize,
          mtimeMs: tail.value.mtimeMs
        })
      )
      yield* Effect.logDebug('Advanced the transcript cursor', { runId, sessionId, lastUuid })
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

    const closeOpenItems = (): ReadonlyArray<Entry> => {
      state.openTools.clear()
      return [...closeReasoning(), ...closeText()]
    }

    const flushLater = (
      item: StreamingItem,
      wait: Duration.Duration,
      currentOf: () => StreamingItem | undefined,
      eventOf: (item: StreamingItem, streaming: boolean) => AgentEvent
    ) =>
      Effect.sleep(wait).pipe(
        Effect.andThen(
          lock.withPermits(1)(
            Effect.gen(function* () {
              item.flushScheduled = false
              if (currentOf() !== item || item.text === item.writtenText) return
              item.lastWriteAt = yield* Clock.currentTimeMillis
              item.writtenText = item.text
              yield* append([{ event: eventOf(item, true) }])
            })
          )
        )
      )

    const streamDelta = Effect.fnUntraced(function* (
      currentOf: () => StreamingItem | undefined,
      delta: string,
      eventOf: (item: StreamingItem, streaming: boolean) => AgentEvent
    ) {
      const now = yield* Clock.currentTimeMillis
      const item = currentOf() ?? {
        itemId: yield* newItemId,
        text: '',
        writtenText: '',
        lastWriteAt: -Infinity,
        flushScheduled: false
      }
      item.text += delta
      const due = now - item.lastWriteAt >= Duration.toMillis(STREAMING_WRITE_INTERVAL)
      if (due) {
        item.lastWriteAt = now
        item.writtenText = item.text
        return { item, entries: [{ event: eventOf(item, true) }] }
      }
      if (!item.flushScheduled) {
        item.flushScheduled = true
        const wait = Duration.millis(
          item.lastWriteAt + Duration.toMillis(STREAMING_WRITE_INTERVAL) - now
        )
        yield* flushLater(item, wait, currentOf, eventOf).pipe(Effect.forkIn(recordingScope))
      }
      return { item, entries: [] }
    })

    const bind = (sessionId: SessionId, newConversation: boolean): ReadonlyArray<Entry> => {
      if (Option.contains(state.boundSession, sessionId)) return []
      state.boundSession = Option.some(sessionId)
      if (newConversation) state.catchUpFailed = false
      state.ownedSession = state.catchUpFailed ? Option.none() : Option.some(sessionId)
      return [{ event: SessionBound.make({ sessionId }) }]
    }

    const rebind = Effect.fnUntraced(function* (sessionId: SessionId, newConversation: boolean) {
      const previous = state.ownedSession
      const entries = bind(sessionId, newConversation)
      if (Option.isNone(previous) || Option.contains(state.ownedSession, previous.value)) {
        return entries
      }
      yield* Effect.logDebug('Left an owned session; queueing its last cursor update', {
        runId,
        sessionId: previous.value
      })
      if (!state.cursorStalled) yield* Queue.offer(cursorUpdates, previous.value)
      return entries
    })

    const entriesFor = Effect.fnUntraced(function* (message: OutboundMessage) {
      switch (message._tag) {
        case 'AssistantThinkingDelta': {
          if (message.text === '') return []
          const { item, entries } = yield* streamDelta(
            () => state.reasoning,
            message.text,
            reasoningEvent
          )
          state.reasoning = item
          return entries
        }
        case 'AssistantTextDelta': {
          if (message.text === '') return []
          const closed = closeReasoning()
          const { item, entries } = yield* streamDelta(() => state.text, message.text, textEvent)
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
          state.openTools.set(message.toolCallId, { toolName: message.toolName, input: {} })
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
        case 'ToolCallUpdated': {
          const tool = state.openTools.get(message.toolCallId)
          if (tool !== undefined && message.input !== undefined) tool.input = message.input
          return []
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
              runId,
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
          return yield* rebind(message.sessionId, false)
        case 'ConversationReset': {
          state.awaitingCheckpoint.splice(0)
          const closed = closeOpenItems()
          return [
            ...closed,
            { event: ConversationCleared.make({}) },
            ...(yield* rebind(message.newSessionId, true))
          ]
        }
        case 'RewoundToCheckpoint':
          return [
            ...closeOpenItems(),
            { event: ConversationRewound.make({ checkpointUuid: message.messageUuid }) }
          ]
        default:
          if (!isTurnEnd(message)) return []
          return [...closeReasoning(), ...closeText()]
      }
    })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* offerCursorUpdate
        yield* Queue.end(cursorUpdates)
        yield* Fiber.join(drain)
        yield* Effect.logDebug('Stopped recording run events', { runId })
      })
    )
    yield* Effect.addFinalizer(() =>
      lock.withPermits(1)(
        append([
          ...closeReasoning(),
          ...closeText(),
          ...Array.from(state.openTools, ([toolCallId, { toolName, input }]) => ({
            event: ToolCallCompleted.make({
              toolCallId,
              toolName,
              input,
              output: '',
              isError: false
            })
          }))
        ])
      )
    )

    return (message: OutboundMessage): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* append(yield* entriesFor(message))
          if (isTurnEnd(message)) yield* offerCursorUpdate
        })
      )
  })

  return RunEventRecorder.of({ open, catchUp })
})

/** The live {@link RunEventRecorder}. Requires `RunEventStore`, {@link Transcripts} and `Crypto`. */
export const RunEventRecorderLive = Layer.effect(RunEventRecorder, makeRecorder)
