import { NodeCrypto, NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { TOOL_OUTPUT_LIMIT } from '@shared/domain/agent-event'
import { SessionId } from '@shared/domain/pane'
import { Context, Duration, Effect, FileSystem, Layer, Option, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { openDatabase } from '../../src/host/services/database'
import {
  RunEventReadError,
  RunEventWriteError,
  TranscriptCursor
} from '../../src/host/services/run-events-seam'
import type {
  TranscriptEntry,
  TranscriptInfo,
  TranscriptTail
} from '../../src/host/session/agent-backend'
import {
  AssistantMessageReceived,
  AssistantTextDelta,
  AssistantThinkingDelta,
  CheckpointAvailable,
  ConversationReset,
  type OutboundMessage,
  RewoundToCheckpoint,
  SessionStarted,
  ToolCallCompleted,
  ToolCallStarted,
  ToolCallUpdated,
  TurnCompleted,
  UserMessagesSent
} from '../../src/host/session/protocol'
import { runEventsMigrations } from './migrations'
import {
  RunEventRecorder,
  RunEventRecorderLive,
  STREAMING_WRITE_INTERVAL,
  Transcripts
} from './recorder'
import { RunEventStore, RunEventStoreLive } from './store'

const storeIn = (dir: string) =>
  Layer.provideMerge(
    RunEventStoreLive,
    Layer.effect(SqlClient.SqlClient, openDatabase(`${dir}/data.db`, runEventsMigrations)).pipe(
      Layer.orDie
    )
  )

const AGENT = '11111111-1111-4111-8111-111111111111'
const SESSION = SessionId.make('33333333-3333-4333-8333-333333333333')
const OTHER_SESSION = SessionId.make('44444444-4444-4444-8444-444444444444')
const CWD = 'F:/work'

const entry = (sourceUuid: string): TranscriptEntry => ({
  sourceUuid,
  event: {
    _tag: 'MessageUpdated',
    itemId: sourceUuid,
    message: { role: 'user', content: sourceUuid },
    streaming: false
  }
})

const tailOf = (...uuids: ReadonlyArray<string>): TranscriptTail => ({
  entries: uuids.map(entry),
  fileSize: 100 * uuids.length,
  mtimeMs: 1_762_128_000_000
})

const infoOf = ({ fileSize, mtimeMs }: TranscriptTail): TranscriptInfo => ({ fileSize, mtimeMs })

const scriptedReader = (
  tail: (afterUuid: Option.Option<string>) => Option.Option<TranscriptTail>,
  info: (sessionId: SessionId) => Option.Option<TranscriptInfo> = () =>
    Option.map(tail(Option.none()), infoOf)
) => {
  const reads: Array<{ readonly sessionId: string; readonly afterUuid: Option.Option<string> }> = []
  const layer = Layer.succeed(Transcripts)({
    transcriptInfo: (sessionId) => Effect.sync(() => info(sessionId)),
    readTranscriptAfter: (sessionId, _cwd, afterUuid) =>
      Effect.sync(() => {
        reads.push({ sessionId, afterUuid })
        return tail(afterUuid)
      })
  })
  return { reads, layer }
}

const unreadTranscript = scriptedReader(() => Option.none()).layer

const run = <A, E>(
  options: {
    readonly resume?: SessionId
    readonly reader?: Layer.Layer<Transcripts>
    readonly seed?: (store: RunEventStore['Service']) => Effect.Effect<void, unknown>
  },
  messages: ReadonlyArray<OutboundMessage>,
  inspect: (store: RunEventStore['Service'], sql: SqlClient.SqlClient) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-run-events-recorder-' })
    const storage = storeIn(dir)
    const context = yield* Layer.build(
      Layer.provideMerge(
        RunEventRecorderLive,
        Layer.mergeAll(storage, options.reader ?? unreadTranscript, NodeCrypto.layer)
      )
    )
    const store = Context.get(context, RunEventStore)
    if (options.seed !== undefined) yield* Effect.orDie(options.seed(store))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const record = yield* Context.get(context, RunEventRecorder).open({
          runId: AGENT,
          cwd: CWD,
          resume: Option.fromUndefinedOr(options.resume)
        })
        for (const message of messages) yield* record(message)
      })
    )
    return yield* inspect(store, Context.get(context, SqlClient.SqlClient))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const itemsOf = (store: RunEventStore['Service']) =>
  store.readHistory(AGENT).pipe(
    Effect.map(({ items }) => items),
    Effect.orDie
  )

const noReads = {
  committed: Stream.empty,
  readAfter: () => Effect.die('not called'),
  readHistory: () => Effect.succeed({ items: [], through: 0 }),
  lastSequence: () => Effect.succeed(0),
  highestSequence: Effect.succeed(0)
}

const withoutIds = (
  items: ReadonlyArray<{ readonly itemId: string }>
): ReadonlyArray<Record<string, unknown>> => items.map(({ itemId: _, ...rest }) => rest)

const eventRows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly event_type: string
    readonly source_uuid: string | null
    readonly payload_json: string
  }>`SELECT event_type, source_uuid, payload_json FROM run_events ORDER BY sequence`.pipe(
    Effect.orDie
  )

const textDelta = (text: string) => AssistantTextDelta.make({ text })
const thinkingDelta = (text: string) => AssistantThinkingDelta.make({ text })
const assistantReceived = (content: string, sourceId?: string) =>
  AssistantMessageReceived.make({ message: { role: 'assistant', content }, sourceId })

describe('RunEventRecorder messages', () => {
  it.effect('stores streamed assistant text as one final message with its source', () =>
    run(
      {},
      [textDelta('Hel'), textDelta('lo'), assistantReceived('Hello', 'a1'), TurnCompleted.make({})],
      (store, sql) =>
        Effect.gen(function* () {
          const items = yield* itemsOf(store)
          const finalRow = (yield* eventRows(sql)).at(-1)

          assert.deepStrictEqual(withoutIds(items), [
            {
              _tag: 'MessageItem',
              position: 0,
              streaming: false,
              message: { role: 'assistant', content: 'Hello' }
            }
          ])
          assert.strictEqual(finalRow?.source_uuid, 'a1')
        })
    )
  )

  const openRecording = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-run-events-recorder-' })
    const context = yield* Layer.build(
      Layer.provideMerge(
        RunEventRecorderLive,
        Layer.mergeAll(storeIn(dir), unreadTranscript, NodeCrypto.layer)
      )
    )
    const record = yield* Context.get(context, RunEventRecorder).open({
      runId: AGENT,
      cwd: CWD,
      resume: Option.none()
    })
    return { record, sql: Context.get(context, SqlClient.SqlClient) }
  })

  const streamedRows = (sql: SqlClient.SqlClient) =>
    Effect.map(eventRows(sql), (rows) =>
      rows.map((row) => {
        const payload = JSON.parse(row.payload_json)
        return `${payload.message.content}${payload.streaming ? '…' : ''}`
      })
    )

  it.effect('writes streamed text once the interval since its last write has passed', () =>
    Effect.gen(function* () {
      const { record, sql } = yield* openRecording

      yield* record(textDelta('a'))
      yield* record(textDelta('b'))
      yield* TestClock.adjust(Duration.subtract(STREAMING_WRITE_INTERVAL, Duration.millis(1)))
      yield* record(textDelta('c'))
      const beforeInterval = yield* streamedRows(sql)
      yield* TestClock.adjust(Duration.millis(1))
      const atInterval = yield* streamedRows(sql)

      assert.deepStrictEqual([beforeInterval, atInterval], [['a…'], ['a…', 'abc…']])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('writes text that arrives right after a write one interval later', () =>
    Effect.gen(function* () {
      const { record, sql } = yield* openRecording
      yield* record(textDelta('a'))

      yield* record(textDelta('b'))
      yield* TestClock.adjust(STREAMING_WRITE_INTERVAL)
      yield* record(textDelta('c'))
      yield* TestClock.adjust(STREAMING_WRITE_INTERVAL)

      assert.deepStrictEqual(yield* streamedRows(sql), ['a…', 'ab…', 'abc…'])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('writes no streaming update after the final message', () =>
    Effect.gen(function* () {
      const { record, sql } = yield* openRecording
      yield* record(textDelta('a'))
      yield* record(textDelta('b'))

      yield* record(assistantReceived('ab', 'a1'))
      yield* TestClock.adjust(Duration.times(STREAMING_WRITE_INTERVAL, 2))

      assert.deepStrictEqual(yield* streamedRows(sql), ['a…', 'ab'])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('finalises thinking with its full text when the answer starts', () =>
    run({}, [thinkingDelta('Let me '), thinkingDelta('look.'), textDelta('Done')], (store) =>
      Effect.gen(function* () {
        const [reasoning] = yield* itemsOf(store)

        assert.deepStrictEqual(withoutIds([reasoning]), [
          { _tag: 'ReasoningItem', position: 0, streaming: false, text: 'Let me look.' }
        ])
      })
    )
  )

  it.effect('stores no item for empty thinking and text deltas', () =>
    run({}, [thinkingDelta(''), textDelta(''), TurnCompleted.make({})], (store) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* itemsOf(store), [])
      })
    )
  )

  it.effect('caps a tool call output and keeps the result message as its source', () =>
    run(
      {},
      [
        ToolCallStarted.make({ toolCallId: 'toolu_1', toolName: 'Bash' }),
        ToolCallCompleted.make({
          toolCallId: 'toolu_1',
          toolName: 'Bash',
          input: { command: 'cat big.log' },
          output: 'x'.repeat(TOOL_OUTPUT_LIMIT + 10),
          isError: false,
          sourceId: 'u7'
        })
      ],
      (store, sql) =>
        Effect.gen(function* () {
          const [tool] = yield* itemsOf(store)
          const completed = (yield* eventRows(sql)).at(-1)

          assert.strictEqual(
            tool._tag === 'ToolCallItem' ? tool.output : undefined,
            `${'x'.repeat(TOOL_OUTPUT_LIMIT)}\n[output truncated: 10 characters omitted]`
          )
          assert.strictEqual(completed?.source_uuid, 'u7')
        })
    )
  )

  it.effect('gives each sent user message its checkpoint, in send order', () =>
    run(
      {},
      [
        UserMessagesSent.make({
          messages: [
            { id: 'm-1', text: 'first' },
            { id: 'm-2', text: 'second' }
          ]
        }),
        CheckpointAvailable.make({ messageUuid: 'u1' }),
        CheckpointAvailable.make({ messageUuid: 'u2', resumeAnchorUuid: 'a1' })
      ],
      (store) =>
        Effect.gen(function* () {
          const items = yield* itemsOf(store)

          assert.deepStrictEqual(items, [
            {
              _tag: 'MessageItem',
              itemId: 'm-1',
              position: 0,
              streaming: false,
              message: { role: 'user', content: 'first', checkpointUuid: 'u1' }
            },
            {
              _tag: 'MessageItem',
              itemId: 'm-2',
              position: 1,
              streaming: false,
              message: {
                role: 'user',
                content: 'second',
                checkpointUuid: 'u2',
                resumeAnchorUuid: 'a1'
              }
            }
          ])
        })
    )
  )

  it.effect('drops the cleared conversation and checkpoints the message sent after the reset', () =>
    run(
      {},
      [
        UserMessagesSent.make({ messages: [{ id: 'm-1', text: '/clear' }] }),
        ConversationReset.make({ newSessionId: OTHER_SESSION }),
        UserMessagesSent.make({ messages: [{ id: 'm-2', text: 'fresh' }] }),
        CheckpointAvailable.make({ messageUuid: 'u2' })
      ],
      (store) =>
        Effect.gen(function* () {
          const items = yield* itemsOf(store)

          assert.deepStrictEqual(
            items.map((item) =>
              item._tag === 'MessageItem' ? [item.itemId, item.message.checkpointUuid] : null
            ),
            [['m-2', 'u2']]
          )
        })
    )
  )

  it.effect('drops the rewound turn and everything after it, open text included', () =>
    run(
      {},
      [
        UserMessagesSent.make({ messages: [{ id: 'm-1', text: 'first' }] }),
        CheckpointAvailable.make({ messageUuid: 'u1' }),
        assistantReceived('reply one', 'a1'),
        UserMessagesSent.make({ messages: [{ id: 'm-2', text: 'second' }] }),
        CheckpointAvailable.make({ messageUuid: 'u2' }),
        textDelta('partial'),
        RewoundToCheckpoint.make({ messageUuid: 'u2' })
      ],
      (store) =>
        Effect.gen(function* () {
          const items = yield* itemsOf(store)

          assert.deepStrictEqual(
            items.map((item) => (item._tag === 'MessageItem' ? item.message.content : item._tag)),
            ['first', 'reply one']
          )
        })
    )
  )

  it.effect('closes a tool call still running with the input it last reported', () =>
    run(
      {},
      [
        ToolCallStarted.make({ toolCallId: 'toolu_1', toolName: 'TodoWrite' }),
        ToolCallUpdated.make({ toolCallId: 'toolu_1', input: { todos: [{ content: 'ship' }] } }),
        ToolCallUpdated.make({ toolCallId: 'toolu_1', elapsedSeconds: 3 })
      ],
      (store) =>
        Effect.gen(function* () {
          const [tool] = yield* itemsOf(store)

          assert.deepStrictEqual(tool._tag === 'ToolCallItem' ? tool.input : tool._tag, {
            todos: [{ content: 'ship' }]
          })
        })
    )
  )

  it.effect('finalises open text and tool calls when the recording closes', () =>
    run(
      {},
      [textDelta('partial'), ToolCallStarted.make({ toolCallId: 'toolu_1', toolName: 'Bash' })],
      (store) =>
        Effect.gen(function* () {
          const items = yield* itemsOf(store)

          assert.deepStrictEqual(withoutIds(items), [
            {
              _tag: 'MessageItem',
              position: 0,
              streaming: false,
              message: { role: 'assistant', content: 'partial' }
            },
            {
              _tag: 'ToolCallItem',
              position: 1,
              running: false,
              toolName: 'Bash',
              input: {},
              output: '',
              isError: false
            }
          ])
        })
    )
  )

  it.effect('binds each distinct session once', () =>
    run(
      {},
      [
        SessionStarted.make({ sessionId: SESSION }),
        SessionStarted.make({ sessionId: SESSION }),
        ConversationReset.make({ newSessionId: OTHER_SESSION })
      ],
      (_store, sql) =>
        Effect.gen(function* () {
          const bound = (yield* eventRows(sql))
            .filter((row) => row.event_type === 'SessionBound')
            .map((row) => JSON.parse(row.payload_json).sessionId)

          assert.deepStrictEqual(bound, [SESSION, OTHER_SESSION])
        })
    )
  )
})

const THIRD_SESSION = SessionId.make('55555555-5555-4555-8555-555555555555')

const seedCursorAtA1 =
  (file: TranscriptInfo = { fileSize: 1, mtimeMs: 1 }) =>
  (store: RunEventStore['Service']) =>
    store.writeCursor(TranscriptCursor.make({ sessionId: SESSION, lastUuid: 'a1', ...file }))

const cursorSessions = (sql: SqlClient.SqlClient) =>
  sql<{ readonly session_id: string }>`SELECT session_id FROM transcript_cursors`.pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map((row) => row.session_id).sort())
  )

describe('RunEventRecorder transcript cursor', () => {
  const readCursor = (store: RunEventStore['Service']) =>
    store.readCursor(SESSION).pipe(Effect.orDie)

  it.effect("moves a new conversation's cursor to the transcript's last entry at turn end", () => {
    const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
    return run(
      { reader: reader.layer },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
      (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* readCursor(store),
            Option.some(
              TranscriptCursor.make({
                sessionId: SESSION,
                lastUuid: 'a1',
                fileSize: 200,
                mtimeMs: 1_762_128_000_000
              })
            )
          )
        })
    )
  })

  it.effect('moves the cursor of a conversation the session resets away from', () => {
    const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
    return run(
      { reader: reader.layer },
      [
        SessionStarted.make({ sessionId: SESSION }),
        ConversationReset.make({ newSessionId: OTHER_SESSION })
      ],
      (store) =>
        Effect.gen(function* () {
          const cursor = yield* readCursor(store)

          assert.deepStrictEqual(
            Option.map(cursor, (stored) => stored.lastUuid),
            Option.some('a1')
          )
        })
    )
  })

  it.effect('owns the session that starts right after a conversation reset', () => {
    const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
    return run(
      { reader: reader.layer },
      [
        SessionStarted.make({ sessionId: SESSION }),
        TurnCompleted.make({}),
        ConversationReset.make({ newSessionId: OTHER_SESSION }),
        SessionStarted.make({ sessionId: THIRD_SESSION }),
        TurnCompleted.make({})
      ],
      (_store, sql) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* cursorSessions(sql),
            [SESSION, OTHER_SESSION, THIRD_SESSION].sort()
          )
        })
    )
  })

  it.effect('owns a session that starts after a finished turn', () => {
    const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
    return run(
      { reader: reader.layer },
      [
        SessionStarted.make({ sessionId: SESSION }),
        TurnCompleted.make({}),
        SessionStarted.make({ sessionId: THIRD_SESSION }),
        TurnCompleted.make({})
      ],
      (_store, sql) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* cursorSessions(sql), [SESSION, THIRD_SESSION].sort())
        })
    )
  })

  it.effect('advances the cursor of a resumed session with nothing after its cursor', () => {
    const reader = scriptedReader((after) =>
      Option.contains(after, 'a1') && reader.reads.length === 1
        ? Option.some(tailOf())
        : Option.some(tailOf('u2', 'a2'))
    )
    return run(
      {
        resume: SESSION,
        reader: reader.layer,
        seed: seedCursorAtA1()
      },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
      (store) =>
        Effect.gen(function* () {
          const cursor = yield* readCursor(store)

          assert.deepStrictEqual(
            Option.map(cursor, (stored) => stored.lastUuid),
            Option.some('a2')
          )
        })
    )
  })

  it.effect('refreshes the size and mtime of a cursor with no entries after it at turn end', () => {
    const touched = { ...tailOf(), fileSize: 300, mtimeMs: 1_762_128_060_000 }
    const reader = scriptedReader(
      () => Option.some(touched),
      () => Option.some({ fileSize: 1, mtimeMs: 1 })
    )
    return run(
      { resume: SESSION, reader: reader.layer, seed: seedCursorAtA1() },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
      (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* readCursor(store),
            Option.some(
              TranscriptCursor.make({
                sessionId: SESSION,
                lastUuid: 'a1',
                fileSize: 300,
                mtimeMs: 1_762_128_060_000
              })
            )
          )
        })
    )
  })

  it.effect('stops advancing the cursor after an event write fails', () =>
    Effect.gen(function* () {
      const cursorWrites: Array<string> = []
      const failingStore = Layer.succeed(RunEventStore)({
        append: () => Effect.fail(new RunEventWriteError({ cause: 'disk full' })),
        appendTranscript: () => Effect.die('not called'),
        ...noReads,
        readCursor: () => Effect.succeed(Option.none()),
        writeCursor: (cursor) => Effect.sync(() => void cursorWrites.push(cursor.lastUuid))
      })
      const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
      const context = yield* Layer.build(
        Layer.provide(
          RunEventRecorderLive,
          Layer.mergeAll(failingStore, reader.layer, NodeCrypto.layer)
        )
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const record = yield* Context.get(context, RunEventRecorder).open({
            runId: AGENT,
            cwd: CWD,
            resume: Option.none()
          })
          yield* record(SessionStarted.make({ sessionId: SESSION }))
          yield* record(assistantReceived('Hello', 'a1'))
          yield* record(TurnCompleted.make({}))
        })
      )

      assert.deepStrictEqual(cursorWrites, [])
    }).pipe(Effect.scoped)
  )
})

describe('RunEventRecorder catch-up', () => {
  const FOURTH_SESSION = SessionId.make('66666666-6666-4666-8666-666666666666')

  const contentsOf = (store: RunEventStore['Service']) =>
    Effect.map(itemsOf(store), (items) =>
      items.map((item) => (item._tag === 'MessageItem' ? item.message.content : item._tag))
    )
  const lastUuidOf = (store: RunEventStore['Service'], sessionId: SessionId) =>
    Effect.map(store.readCursor(sessionId).pipe(Effect.orDie), (cursor) =>
      Option.map(cursor, (stored) => stored.lastUuid)
    )

  it.effect('appends the turns a resumed session gained outside dia after its cursor', () => {
    const reader = scriptedReader((after) =>
      Option.some(
        Option.contains(after, 'a1') ? tailOf('u2', 'a2') : tailOf('u1', 'a1', 'u2', 'a2')
      )
    )
    return run({ resume: SESSION, reader: reader.layer, seed: seedCursorAtA1() }, [], (store) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* contentsOf(store), ['u2', 'a2'])
        assert.deepStrictEqual(yield* lastUuidOf(store, SESSION), Option.some('a2'))
      })
    )
  })

  it.effect('imports the whole transcript of a resumed session with no cursor', () => {
    const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
    return run({ resume: SESSION, reader: reader.layer }, [], (store) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* contentsOf(store), ['u1', 'a1'])
        assert.deepStrictEqual(yield* lastUuidOf(store, SESSION), Option.some('a1'))
      })
    )
  })

  it.effect('appends nothing when the transcript size and mtime equal the cursor', () => {
    const tail = tailOf('u2', 'a2')
    const reader = scriptedReader(() => Option.some(tail))
    return run(
      { resume: SESSION, reader: reader.layer, seed: seedCursorAtA1(infoOf(tail)) },
      [],
      (_store, sql) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* eventRows(sql), [])
        })
    )
  })

  it.effect('owns a resumed session whose transcript equals its cursor', () => {
    const tail = tailOf('u2', 'a2')
    const reader = scriptedReader(() => Option.some(tail))
    return run(
      { resume: SESSION, reader: reader.layer, seed: seedCursorAtA1(infoOf(tail)) },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
      (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* lastUuidOf(store, SESSION), Option.some('a2'))
        })
    )
  })

  it.effect('leaves a resumed session unowned when its tail cannot be read', () => {
    const later = tailOf('u1', 'a1')
    const reader = scriptedReader(
      () => (reader.reads.length === 1 ? Option.none() : Option.some(later)),
      () => Option.some(infoOf(later))
    )
    return run(
      { resume: SESSION, reader: reader.layer },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
      (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* lastUuidOf(store, SESSION), Option.none())
        })
    )
  })

  it.effect('stores nothing for a resumed session with no transcript', () => {
    const reader = scriptedReader(
      () => Option.some(tailOf('u1', 'a1')),
      () => Option.none()
    )
    return run(
      { resume: SESSION, reader: reader.layer },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
      (store, sql) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            (yield* eventRows(sql)).map((row) => row.event_type),
            ['SessionBound']
          )
          assert.deepStrictEqual(yield* lastUuidOf(store, SESSION), Option.none())
        })
    )
  })

  const recordWithStore = (
    store: Partial<RunEventStore['Service']>,
    messages: ReadonlyArray<OutboundMessage>
  ) =>
    Effect.gen(function* () {
      const cursorWrites: Array<string> = []
      const fakeStore = Layer.succeed(RunEventStore)({
        append: () => Effect.succeed([]),
        appendTranscript: () => Effect.void,
        ...noReads,
        readCursor: () => Effect.succeed(Option.none()),
        writeCursor: (cursor) => Effect.sync(() => void cursorWrites.push(cursor.lastUuid)),
        ...store
      })
      const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
      const context = yield* Layer.build(
        Layer.provide(
          RunEventRecorderLive,
          Layer.mergeAll(fakeStore, reader.layer, NodeCrypto.layer)
        )
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const record = yield* Context.get(context, RunEventRecorder).open({
            runId: AGENT,
            cwd: CWD,
            resume: Option.some(SESSION)
          })
          for (const message of messages) yield* record(message)
        })
      )
      return cursorWrites
    }).pipe(Effect.scoped)

  const resumedTurn = [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})]

  it.effect('leaves a resumed session unowned when its cursor cannot be read at catch-up', () =>
    Effect.gen(function* () {
      let cursorReads = 0
      const cursorWrites = yield* recordWithStore(
        {
          readCursor: () =>
            cursorReads++ === 0
              ? Effect.fail(new RunEventReadError({ cause: 'locked' }))
              : Effect.succeed(Option.none())
        },
        resumedTurn
      )

      assert.deepStrictEqual(cursorWrites, [])
    })
  )

  it.effect('leaves a resumed session unowned when its tail cannot be stored', () =>
    Effect.gen(function* () {
      const cursorWrites = yield* recordWithStore(
        { appendTranscript: () => Effect.fail(new RunEventWriteError({ cause: 'disk full' })) },
        resumedTurn
      )

      assert.deepStrictEqual(cursorWrites, [])
    })
  )

  it.effect('owns no session after a failed catch-up until a conversation reset', () => {
    const reader = scriptedReader(
      () => Option.some(tailOf('u1', 'a1')),
      () => Option.none()
    )
    return run(
      { resume: SESSION, reader: reader.layer },
      [
        SessionStarted.make({ sessionId: SESSION }),
        TurnCompleted.make({}),
        SessionStarted.make({ sessionId: OTHER_SESSION }),
        TurnCompleted.make({}),
        ConversationReset.make({ newSessionId: THIRD_SESSION }),
        SessionStarted.make({ sessionId: FOURTH_SESSION }),
        TurnCompleted.make({})
      ],
      (_store, sql) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* cursorSessions(sql), [THIRD_SESSION, FOURTH_SESSION].sort())
        })
    )
  })

  it.effect('owns a session under another id after a successful catch-up', () => {
    const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
    return run(
      { resume: SESSION, reader: reader.layer },
      [
        SessionStarted.make({ sessionId: SESSION }),
        SessionStarted.make({ sessionId: OTHER_SESSION }),
        TurnCompleted.make({})
      ],
      (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* lastUuidOf(store, OTHER_SESSION), Option.some('a1'))
        })
    )
  })
})
