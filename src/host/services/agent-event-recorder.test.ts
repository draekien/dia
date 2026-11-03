import { NodeCrypto, NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { TOOL_OUTPUT_LIMIT } from '@shared/domain/agent-event'
import { SessionId } from '@shared/domain/pane'
import { Context, Duration, Effect, FileSystem, Layer, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import type { TranscriptEntry, TranscriptTail } from '../session/agent-backend'
import {
  AssistantMessageReceived,
  AssistantTextDelta,
  AssistantThinkingDelta,
  CheckpointAvailable,
  ConversationReset,
  type OutboundMessage,
  SessionStarted,
  ToolCallCompleted,
  ToolCallStarted,
  TurnCompleted,
  UserMessagesSent
} from '../session/protocol'
import {
  AgentEventRecorder,
  AgentEventRecorderLive,
  STREAMING_WRITE_INTERVAL
} from './agent-event-recorder'
import {
  AgentEventStore,
  AgentEventStoreLive,
  AgentEventWriteError,
  TranscriptCursor
} from './agent-event-store'
import { makeHostDatabaseLive } from './database'
import { TranscriptReader } from './transcript-reader'

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

interface TranscriptScript {
  readonly reads: Array<{ readonly sessionId: string; readonly afterUuid: Option.Option<string> }>
}

const scriptedReader = (
  tail: (afterUuid: Option.Option<string>) => Option.Option<TranscriptTail>
) => {
  const script: TranscriptScript = { reads: [] }
  const layer = Layer.succeed(TranscriptReader)({
    readHistory: () => Effect.die('not called'),
    discoverSessions: () => Effect.die('not called'),
    readTranscriptAfter: (sessionId, _cwd, afterUuid) =>
      Effect.sync(() => {
        script.reads.push({ sessionId, afterUuid })
        return tail(afterUuid)
      })
  })
  return { script, layer }
}

const unreadTranscript = scriptedReader(() => Option.none()).layer

const run = <A, E>(
  options: {
    readonly resume?: SessionId
    readonly reader?: Layer.Layer<TranscriptReader>
    readonly seed?: (store: AgentEventStore['Service']) => Effect.Effect<void, unknown>
  },
  messages: ReadonlyArray<OutboundMessage>,
  inspect: (store: AgentEventStore['Service'], sql: SqlClient.SqlClient) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-agent-event-recorder-' })
    const storage = Layer.provideMerge(AgentEventStoreLive, makeHostDatabaseLive(dir))
    const context = yield* Layer.build(
      Layer.provideMerge(
        AgentEventRecorderLive,
        Layer.mergeAll(storage, options.reader ?? unreadTranscript, NodeCrypto.layer)
      )
    )
    const store = Context.get(context, AgentEventStore)
    if (options.seed !== undefined) yield* Effect.orDie(options.seed(store))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const record = yield* Context.get(context, AgentEventRecorder).open({
          agentId: AGENT,
          cwd: CWD,
          resume: Option.fromUndefinedOr(options.resume)
        })
        for (const message of messages) yield* record(message)
      })
    )
    return yield* inspect(store, Context.get(context, SqlClient.SqlClient))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const itemsOf = (store: AgentEventStore['Service']) =>
  store.readItems(AGENT, { limit: 100 }).pipe(Effect.orDie)

const withoutIds = (
  items: ReadonlyArray<{ readonly itemId: string }>
): ReadonlyArray<Record<string, unknown>> => items.map(({ itemId: _, ...rest }) => rest)

const eventRows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly event_type: string
    readonly source_uuid: string | null
    readonly payload_json: string
  }>`SELECT event_type, source_uuid, payload_json FROM agent_events ORDER BY sequence`.pipe(
    Effect.orDie
  )

const textDelta = (text: string) => AssistantTextDelta.make({ text })
const thinkingDelta = (text: string) => AssistantThinkingDelta.make({ text })
const assistantReceived = (content: string, sourceId?: string) =>
  AssistantMessageReceived.make({ message: { role: 'assistant', content }, sourceId })

describe('AgentEventRecorder messages', () => {
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

  it.effect('writes a streaming update at most once per interval', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-agent-event-recorder-' })
      const context = yield* Layer.build(
        Layer.provideMerge(
          AgentEventRecorderLive,
          Layer.mergeAll(
            Layer.provideMerge(AgentEventStoreLive, makeHostDatabaseLive(dir)),
            unreadTranscript,
            NodeCrypto.layer
          )
        )
      )
      const sql = Context.get(context, SqlClient.SqlClient)
      const record = yield* Context.get(context, AgentEventRecorder).open({
        agentId: AGENT,
        cwd: CWD,
        resume: Option.none()
      })

      yield* record(textDelta('a'))
      yield* record(textDelta('b'))
      yield* TestClock.adjust(Duration.subtract(STREAMING_WRITE_INTERVAL, Duration.millis(1)))
      yield* record(textDelta('c'))
      yield* TestClock.adjust(Duration.millis(1))
      yield* record(textDelta('d'))

      const streamed = (yield* eventRows(sql)).map(
        (row) => JSON.parse(row.payload_json).message.content
      )
      assert.deepStrictEqual(streamed, ['a', 'abcd'])
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
          const bound = (yield* eventRows(sql)).map((row) => JSON.parse(row.payload_json).sessionId)

          assert.deepStrictEqual(bound, [SESSION, OTHER_SESSION])
        })
    )
  )
})

describe('AgentEventRecorder transcript cursor', () => {
  const readCursor = (store: AgentEventStore['Service']) =>
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

  it.effect('leaves the cursor of a resumed session that has none to catch-up', () => {
    const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
    return run(
      { resume: SESSION, reader: reader.layer },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
      (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* readCursor(store), Option.none())
        })
    )
  })

  it.effect('advances the cursor of a resumed session with nothing after its cursor', () => {
    const reader = scriptedReader((after) =>
      Option.contains(after, 'a1') && reader.script.reads.length === 1
        ? Option.some(tailOf())
        : Option.some(tailOf('u2', 'a2'))
    )
    return run(
      {
        resume: SESSION,
        reader: reader.layer,
        seed: (store) =>
          store.writeCursor(
            TranscriptCursor.make({ sessionId: SESSION, lastUuid: 'a1', fileSize: 1, mtimeMs: 1 })
          )
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

  it.effect('leaves the cursor of a resumed session with unread entries to catch-up', () => {
    const reader = scriptedReader(() => Option.some(tailOf('u2', 'a2')))
    return run(
      {
        resume: SESSION,
        reader: reader.layer,
        seed: (store) =>
          store.writeCursor(
            TranscriptCursor.make({ sessionId: SESSION, lastUuid: 'a1', fileSize: 1, mtimeMs: 1 })
          )
      },
      [SessionStarted.make({ sessionId: SESSION }), TurnCompleted.make({})],
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

  it.effect('stops advancing the cursor after an event write fails', () =>
    Effect.gen(function* () {
      const cursorWrites: Array<string> = []
      const failingStore = Layer.succeed(AgentEventStore)({
        append: () => Effect.fail(new AgentEventWriteError({ cause: 'disk full' })),
        readItems: () => Effect.succeed([]),
        readCursor: () => Effect.succeed(Option.none()),
        writeCursor: (cursor) => Effect.sync(() => void cursorWrites.push(cursor.lastUuid))
      })
      const reader = scriptedReader(() => Option.some(tailOf('u1', 'a1')))
      const context = yield* Layer.build(
        Layer.provide(
          AgentEventRecorderLive,
          Layer.mergeAll(failingStore, reader.layer, NodeCrypto.layer)
        )
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const record = yield* Context.get(context, AgentEventRecorder).open({
            agentId: AGENT,
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
