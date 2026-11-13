import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import {
  AgentArchived,
  AgentUnarchived,
  ConversationCleared,
  ConversationRewound,
  MessageItem,
  MessageUpdated,
  ReasoningItem,
  ReasoningUpdated,
  SessionBound,
  ToolCallCompleted,
  ToolCallItem,
  ToolCallStarted
} from '@shared/domain/agent-event'
import { SessionId } from '@shared/domain/pane'
import { PaneTurnStatusChanged } from '@shared/ipc/contract'
import { Context, Effect, Fiber, FileSystem, Layer, Option, type Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { openDatabase } from '../../src/host/services/database'
import { ReloadRequired, Replay, TranscriptCursor } from '../../src/host/services/run-events-seam'
import { runEventsMigrations } from './migrations'
import { RunEventStore, RunEventStoreLive, TRANSCRIPT_BATCH_SIZE } from './store'

const AGENT_A = '11111111-1111-4111-8111-111111111111'
const AGENT_B = '22222222-2222-4222-8222-222222222222'

const userMessage = (content: string) => ({ role: 'user' as const, content })

const messageUpdated = (itemId: string, content: string, streaming: boolean) =>
  MessageUpdated.make({ itemId, message: { role: 'assistant', content }, streaming })

const toolCompleted = (toolCallId: string, output: string) =>
  ToolCallCompleted.make({
    toolCallId,
    toolName: 'Bash',
    input: { command: 'ls' },
    output,
    isError: false
  })

const withStore = <A, E>(
  body: (
    store: RunEventStore['Service'],
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-run-events-store-' })
    const context = yield* Layer.build(
      Layer.provideMerge(
        RunEventStoreLive,
        Layer.effect(SqlClient.SqlClient, openDatabase(`${dir}/data.db`, runEventsMigrations)).pipe(
          Layer.orDie
        )
      )
    )
    return yield* body(
      Context.get(context, RunEventStore),
      Context.get(context, SqlClient.SqlClient)
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const eventCount = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM run_events`, (rows) => rows[0].n)

describe('RunEventStore.append', () => {
  it.effect('keeps one item at its first position with the latest payload across updates', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: messageUpdated('m1', 'Hel', true) },
          { event: messageUpdated('m1', 'Hello', false) }
        ])

        const items = (yield* store.readHistory(AGENT_A)).items

        assert.deepStrictEqual(items, [
          MessageItem.make({
            itemId: 'm1',
            position: 0,
            streaming: false,
            message: { role: 'assistant', content: 'Hello' }
          })
        ])
      })
    )
  )

  it.effect('places new items in the order their first events arrive', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          {
            event: MessageUpdated.make({
              itemId: 'u1',
              message: userMessage('hi'),
              streaming: false
            })
          },
          { event: ReasoningUpdated.make({ itemId: 'r1', text: 'thinking', streaming: true }) },
          { event: ToolCallStarted.make({ toolCallId: 't1', toolName: 'Bash' }) }
        ])

        const items = (yield* store.readHistory(AGENT_A)).items

        assert.deepStrictEqual(items, [
          MessageItem.make({
            itemId: 'u1',
            position: 0,
            streaming: false,
            message: userMessage('hi')
          }),
          ReasoningItem.make({ itemId: 'r1', position: 1, streaming: true, text: 'thinking' }),
          ToolCallItem.make({ itemId: 't1', position: 2, running: true, toolName: 'Bash' })
        ])
      })
    )
  )

  it.effect(
    'returns None for an event whose source uuid and item are stored, and stores nothing for it',
    () =>
      withStore((store, sql) =>
        Effect.gen(function* () {
          yield* store.append(AGENT_A, [
            { event: messageUpdated('m1', 'first', false), sourceUuid: 'u-1' }
          ])

          const result = yield* store.append(AGENT_A, [
            { event: messageUpdated('m1', 'replayed', false), sourceUuid: 'u-1' }
          ])

          assert.deepStrictEqual(result, [Option.none()])
          assert.strictEqual(yield* eventCount(sql), 1)
          const items = (yield* store.readHistory(AGENT_A)).items
          assert.strictEqual(items[0]._tag === 'MessageItem' && items[0].message.content, 'first')
        })
      )
  )

  it.effect('returns one entry per input, with None only for the skipped event', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: messageUpdated('m1', 'a', false), sourceUuid: 'u-1' }
        ])

        const result = yield* store.append(AGENT_A, [
          { event: messageUpdated('m2', 'b', false), sourceUuid: 'u-2' },
          { event: messageUpdated('m1', 'a', false), sourceUuid: 'u-1' },
          { event: messageUpdated('m3', 'c', false), sourceUuid: 'u-3' }
        ])

        assert.deepStrictEqual(result.map(Option.isSome), [true, false, true])
        const [first, third] = result.flatMap(Option.toArray)
        assert.isBelow(first, third)
      })
    )
  )

  it.effect('stores every tool result that shares one source uuid', () =>
    withStore((store) =>
      Effect.gen(function* () {
        const result = yield* store.append(AGENT_A, [
          { event: toolCompleted('t1', 'one'), sourceUuid: 'u-results' },
          { event: toolCompleted('t2', 'two'), sourceUuid: 'u-results' }
        ])

        assert.deepStrictEqual(result.map(Option.isSome), [true, true])
        const items = (yield* store.readHistory(AGENT_A)).items
        assert.deepStrictEqual(
          items.map((item) => item.itemId),
          ['t1', 't2']
        )
      })
    )
  )

  it.effect('keeps the same item id of two agents as two items', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [{ event: messageUpdated('m1', 'from A', false) }])
        yield* store.append(AGENT_B, [{ event: messageUpdated('m1', 'from B', false) }])

        const a = (yield* store.readHistory(AGENT_A)).items
        const b = (yield* store.readHistory(AGENT_B)).items

        assert.deepStrictEqual(
          [a, b].map((items) =>
            items.map((item) => item._tag === 'MessageItem' && item.message.content)
          ),
          [['from A'], ['from B']]
        )
      })
    )
  )

  it.effect('stores an event of a second agent that shares the source uuid and item id', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: messageUpdated('m1', 'forked', false), sourceUuid: 'u-1' }
        ])

        const result = yield* store.append(AGENT_B, [
          { event: messageUpdated('m1', 'forked', false), sourceUuid: 'u-1' }
        ])

        assert.deepStrictEqual(result.map(Option.isSome), [true])
      })
    )
  )

  it.effect('stores nothing from a batch whose projection write fails', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* sql`DROP TABLE run_items`

        const error = yield* Effect.flip(
          store.append(AGENT_A, [
            { event: SessionBound.make({ sessionId: SessionId.make('session-1') }) },
            { event: messageUpdated('m1', 'lost', false) }
          ])
        )

        assert.strictEqual(error._tag, 'RunEventWriteError')
        assert.strictEqual(yield* eventCount(sql), 0)
      })
    )
  )

  it.effect('marks a started tool call done when it completes', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: ToolCallStarted.make({ toolCallId: 't1', toolName: 'Bash' }) },
          { event: toolCompleted('t1', 'file.txt') }
        ])

        const items = (yield* store.readHistory(AGENT_A)).items

        assert.deepStrictEqual(items, [
          ToolCallItem.make({
            itemId: 't1',
            position: 0,
            running: false,
            toolName: 'Bash',
            input: { command: 'ls' },
            output: 'file.txt',
            isError: false
          })
        ])
      })
    )
  )

  it.effect('leaves a completed tool call done when its start arrives later', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: toolCompleted('t1', 'file.txt') },
          { event: ToolCallStarted.make({ toolCallId: 't1', toolName: 'Bash' }) }
        ])

        const items = (yield* store.readHistory(AGENT_A)).items

        assert.isTrue(items[0]._tag === 'ToolCallItem' && !items[0].running)
      })
    )
  )
})

describe('RunEventStore compaction on AgentArchived', () => {
  const reasoningUpdated = (itemId: string, text: string, streaming: boolean) =>
    ReasoningUpdated.make({ itemId, text, streaming })

  const conversation = [
    { event: messageUpdated('m1', 'He', true) },
    { event: messageUpdated('m1', 'Hel', true) },
    { event: messageUpdated('m1', 'Hello', false) },
    { event: reasoningUpdated('r1', 'Thin', true) },
    { event: reasoningUpdated('r1', 'Thinking', false) },
    { event: ToolCallStarted.make({ toolCallId: 't1', toolName: 'Bash' }) },
    { event: toolCompleted('t1', 'ok') },
    { event: messageUpdated('m2', 'Interrup', true) }
  ]

  const storedEvents = (sql: SqlClient.SqlClient, runId: string) =>
    sql<{
      readonly event_type: string
      readonly item_id: string | null
      readonly streaming: number | null
    }>`SELECT event_type, item_id, json_extract(payload_json, '$.streaming') AS streaming
      FROM run_events WHERE run_id = ${runId} ORDER BY sequence`

  it.effect(
    'keeps only the final event of each streamed message and reasoning span, tool calls and an unfinished stream',
    () =>
      withStore((store, sql) =>
        Effect.gen(function* () {
          yield* store.append(AGENT_A, conversation)

          yield* store.append(AGENT_A, [{ event: AgentArchived.make({}) }])

          assert.deepStrictEqual(yield* storedEvents(sql, AGENT_A), [
            { event_type: 'MessageUpdated', item_id: 'm1', streaming: 0 },
            { event_type: 'ReasoningUpdated', item_id: 'r1', streaming: 0 },
            { event_type: 'ToolCallStarted', item_id: 't1', streaming: null },
            { event_type: 'ToolCallCompleted', item_id: 't1', streaming: null },
            { event_type: 'MessageUpdated', item_id: 'm2', streaming: 1 },
            { event_type: 'AgentArchived', item_id: null, streaming: null }
          ])
        })
      )
  )

  it.effect('leaves the history read from the items unchanged', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, conversation)
        const before = (yield* store.readHistory(AGENT_A)).items

        yield* store.append(AGENT_A, [{ event: AgentArchived.make({}) }])

        assert.deepStrictEqual((yield* store.readHistory(AGENT_A)).items, before)
      })
    )
  )

  it.effect('leaves the streaming events of other agents', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_B, conversation)

        yield* store.append(AGENT_A, [{ event: AgentArchived.make({}) }])

        assert.strictEqual((yield* storedEvents(sql, AGENT_B)).length, conversation.length)
      })
    )
  )
})

const threeMessages = [
  { event: messageUpdated('m0', 'zero', false) },
  { event: messageUpdated('m1', 'one', false) },
  { event: messageUpdated('m2', 'two', false) }
]

const sequencesOf = (result: ReadonlyArray<Option.Option<number>>) =>
  result.flatMap((sequence) => (Option.isSome(sequence) ? [sequence.value] : []))

const turnStatus = (label: string | null) => PaneTurnStatusChanged.make({ paneId: AGENT_A, label })

describe('RunEventStore.readHistory', () => {
  it.effect('returns every item in position order with the last sequence of the agent', () =>
    withStore((store) =>
      Effect.gen(function* () {
        const appended = sequencesOf(yield* store.append(AGENT_A, threeMessages))

        const history = yield* store.readHistory(AGENT_A)

        assert.deepStrictEqual(
          history.items.map((item) => item.itemId),
          ['m0', 'm1', 'm2']
        )
        assert.strictEqual(history.through, appended.at(-1))
      })
    )
  )

  it.effect('returns no items and sequence 0 for an agent with no events', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_B, threeMessages)

        const history = yield* store.readHistory(AGENT_A)

        assert.deepStrictEqual(history, { items: [], through: 0 })
      })
    )
  )

  it.effect('counts a stored pane signal in the last sequence but adds no item', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)
        const [signal] = sequencesOf(
          yield* store.append(AGENT_A, [{ event: turnStatus('Thinking') }])
        )

        const history = yield* store.readHistory(AGENT_A)

        assert.strictEqual(history.items.length, 3)
        assert.strictEqual(history.through, signal)
      })
    )
  )

  it.effect('leaves out a stored item that does not decode', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)
        yield* sql`UPDATE run_items SET payload_json = 'not json' WHERE item_id = 'm1'`

        const { items } = yield* store.readHistory(AGENT_A)

        assert.deepStrictEqual(
          items.map((item) => item.itemId),
          ['m0', 'm2']
        )
      })
    )
  )
})

describe('RunEventStore projection of a cleared or rewound conversation', () => {
  const userTurn = (itemId: string, checkpointUuid: string) =>
    MessageUpdated.make({
      itemId,
      message: { ...userMessage(itemId), checkpointUuid },
      streaming: false
    })

  it.effect('drops every item when the conversation is cleared', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)
        yield* store.append(AGENT_A, [{ event: ConversationCleared.make({}) }])
        yield* store.append(AGENT_A, [{ event: messageUpdated('m3', 'after', false) }])

        const { items } = yield* store.readHistory(AGENT_A)

        assert.deepStrictEqual(
          items.map((item) => [item.itemId, item.position]),
          [['m3', 0]]
        )
      })
    )
  )

  it.effect('drops the rewound user turn and every item after it', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: userTurn('u1', 'cp-1') },
          { event: messageUpdated('a1', 'first reply', false) },
          { event: userTurn('u2', 'cp-2') },
          { event: messageUpdated('a2', 'second reply', false) }
        ])

        yield* store.append(AGENT_A, [
          { event: ConversationRewound.make({ checkpointUuid: 'cp-2' }) }
        ])

        const { items } = yield* store.readHistory(AGENT_A)
        assert.deepStrictEqual(
          items.map((item) => item.itemId),
          ['u1', 'a1']
        )
      })
    )
  )

  it.effect('keeps every item when no user turn has the rewound checkpoint', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: userTurn('u1', 'cp-1') },
          { event: messageUpdated('a1', 'reply', false) }
        ])

        yield* store.append(AGENT_A, [
          { event: ConversationRewound.make({ checkpointUuid: 'cp-unknown' }) }
        ])

        const { items } = yield* store.readHistory(AGENT_A)
        assert.deepStrictEqual(
          items.map((item) => item.itemId),
          ['u1', 'a1']
        )
      })
    )
  )
})

describe('RunEventStore.readAfter', () => {
  const roomy = { maxEvents: 100, maxBytes: 1_000_000 }

  it.effect('replays the events after the cursor in sequence order, signals included', () =>
    withStore((store) =>
      Effect.gen(function* () {
        const [first] = sequencesOf(yield* store.append(AGENT_A, threeMessages.slice(0, 1)))
        const later = sequencesOf(
          yield* store.append(AGENT_A, [
            { event: turnStatus('Thinking') },
            { event: messageUpdated('m1', 'one', false) }
          ])
        )

        const read = yield* store.readAfter(AGENT_A, first, roomy)

        assert.deepStrictEqual(
          read._tag === 'Replay'
            ? read.events.map((event) => [event.sequence, event.event._tag])
            : read,
          [
            [later[0], 'PaneTurnStatusChanged'],
            [later[1], 'MessageUpdated']
          ]
        )
      })
    )
  )

  it.effect('reports the last sequence of the agent as the replay end', () =>
    withStore((store) =>
      Effect.gen(function* () {
        const appended = sequencesOf(yield* store.append(AGENT_A, threeMessages))

        const read = yield* store.readAfter(AGENT_A, appended.at(-1) ?? 0, roomy)

        assert.deepStrictEqual(read, Replay.make({ events: [], through: appended.at(-1) ?? 0 }))
      })
    )
  )

  it.effect('leaves out the events of other agents', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_B, threeMessages)
        const mine = sequencesOf(yield* store.append(AGENT_A, threeMessages.slice(0, 1)))

        const read = yield* store.readAfter(AGENT_A, 0, roomy)

        assert.deepStrictEqual(
          read._tag === 'Replay' ? read.events.map((event) => event.sequence) : read,
          mine
        )
      })
    )
  )

  it.effect('requires a reload for a cursor past the last event of the agent', () =>
    withStore((store) =>
      Effect.gen(function* () {
        const appended = sequencesOf(yield* store.append(AGENT_A, threeMessages))

        const read = yield* store.readAfter(AGENT_A, (appended.at(-1) ?? 0) + 1, roomy)

        assert.deepStrictEqual(read, ReloadRequired.make({ reason: 'ahead' }))
      })
    )
  )

  it.effect('replays exactly as many events as the limit allows', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)

        const read = yield* store.readAfter(AGENT_A, 0, { maxEvents: 3, maxBytes: 1_000_000 })

        assert.strictEqual(read._tag === 'Replay' ? read.events.length : read._tag, 3)
      })
    )
  )

  it.effect('requires a reload for one event more than the limit allows', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)

        const read = yield* store.readAfter(AGENT_A, 0, { maxEvents: 2, maxBytes: 1_000_000 })

        assert.deepStrictEqual(read, ReloadRequired.make({ reason: 'tooLarge' }))
      })
    )
  )

  it.effect('measures the byte limit in UTF-8 bytes, not characters', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [{ event: messageUpdated('m0', 'éééé', false) }])
        const [row] = yield* sql<{ readonly payload_json: string }>`SELECT payload_json
          FROM run_events`
        const bytes = Buffer.byteLength(row.payload_json, 'utf8')
        assert.isAbove(bytes, row.payload_json.length)

        const atLimit = yield* store.readAfter(AGENT_A, 0, { maxEvents: 10, maxBytes: bytes })
        const overLimit = yield* store.readAfter(AGENT_A, 0, {
          maxEvents: 10,
          maxBytes: bytes - 1
        })

        assert.strictEqual(atLimit._tag, 'Replay')
        assert.deepStrictEqual(overLimit, ReloadRequired.make({ reason: 'tooLarge' }))
      })
    )
  )

  it.effect('requires a reload when an event after the cursor does not decode', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)
        yield* sql`UPDATE run_events SET payload_json = 'not json' WHERE item_id = 'm1'`

        const read = yield* store.readAfter(AGENT_A, 0, roomy)

        assert.deepStrictEqual(read, ReloadRequired.make({ reason: 'undecodable' }))
      })
    )
  )

  it.effect('requires a reload when host.db cannot be read', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* sql`DROP TABLE run_events`

        const read = yield* store.readAfter(AGENT_A, 0, roomy)

        assert.deepStrictEqual(read, ReloadRequired.make({ reason: 'readFailed' }))
      })
    )
  )
})

describe('RunEventStore.committed', () => {
  it.effect('offers every appended event after its commit, in sequence order', () =>
    withStore((store) =>
      Effect.gen(function* () {
        const received = yield* store.committed.pipe(
          Stream.take(20),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true })
        )

        const appended = yield* Effect.forEach(
          Array.from({ length: 20 }, (_, index) => index),
          (index) =>
            store.append(index % 2 === 0 ? AGENT_A : AGENT_B, [
              { event: messageUpdated(`m${index}`, 'x', false) }
            ]),
          { concurrency: 'unbounded' }
        )

        const sequences = (yield* Fiber.join(received)).map((event) => event.sequence)
        assert.deepStrictEqual(
          sequences,
          appended.flatMap(sequencesOf).sort((a, b) => a - b)
        )
      })
    )
  )

  it.effect('offers nothing for a skipped event or a failed batch', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: messageUpdated('m0', 'zero', false), sourceUuid: 'u0' }
        ])
        const received = yield* store.committed.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true })
        )

        yield* store.append(AGENT_A, [
          { event: messageUpdated('m0', 'zero', false), sourceUuid: 'u0' }
        ])
        yield* sql`DROP TABLE run_items`
        yield* Effect.flip(store.append(AGENT_A, [{ event: messageUpdated('m1', 'lost', false) }]))
        const [marker] = sequencesOf(yield* store.append(AGENT_A, [{ event: turnStatus(null) }]))

        const events = yield* Fiber.join(received)
        assert.deepStrictEqual(
          events.map((event) => event.sequence),
          [marker]
        )
      })
    )
  )
})

describe('RunEventStore.subscribe', () => {
  it.effect('holds an event appended after the call and before the stream is first pulled', () =>
    withStore((store) =>
      Effect.gen(function* () {
        const later = yield* store.subscribe
        const [sequence] = sequencesOf(
          yield* store.append(AGENT_A, [{ event: messageUpdated('m0', 'zero', false) }])
        )

        const received = yield* later.pipe(Stream.take(1), Stream.runCollect)

        assert.deepStrictEqual(
          received.map((event) => event.sequence),
          [sequence]
        )
      })
    )
  )
})

describe('reopening the run event database', () => {
  const SESSION = SessionId.make('44444444-4444-4444-8444-444444444444')

  it.effect('keeps the events, items and cursors of every run', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-run-events-store-' })
      const build = Layer.build(
        Layer.provideMerge(
          RunEventStoreLive,
          Layer.effect(
            SqlClient.SqlClient,
            openDatabase(`${dir}/data.db`, runEventsMigrations)
          ).pipe(Layer.orDie)
        )
      )
      const cursor = TranscriptCursor.make({
        sessionId: SESSION,
        lastUuid: 'a1',
        fileSize: 4_821,
        mtimeMs: 1_762_128_000_000
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = Context.get(yield* build, RunEventStore)
          yield* store.append(AGENT_A, threeMessages)
          yield* store.append(AGENT_B, threeMessages)
          yield* store.writeCursor(cursor)
        })
      )

      const store = Context.get(yield* build, RunEventStore)
      const histories = [yield* store.readHistory(AGENT_A), yield* store.readHistory(AGENT_B)]

      assert.deepStrictEqual(
        histories.map(({ items }) => items.length),
        [threeMessages.length, threeMessages.length]
      )
      assert.deepStrictEqual(yield* store.readCursor(SESSION), Option.some(cursor))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe('RunEventStore cursors', () => {
  const SESSION = SessionId.make('33333333-3333-4333-8333-333333333333')
  const cursorAt = (lastUuid: string, fileSize: number) =>
    TranscriptCursor.make({ sessionId: SESSION, lastUuid, fileSize, mtimeMs: 1_762_128_000_000 })

  it.effect('reads none for a session with no cursor', () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* store.readCursor(SESSION), Option.none())
      })
    )
  )

  it.effect('reads back the cursor it stored', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.writeCursor(cursorAt('a1', 4_821))

        assert.deepStrictEqual(yield* store.readCursor(SESSION), Option.some(cursorAt('a1', 4_821)))
      })
    )
  )

  it.effect('replaces the earlier cursor of the same session', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.writeCursor(cursorAt('a1', 4_821))
        yield* store.writeCursor(cursorAt('a2', 9_000))

        assert.deepStrictEqual(yield* store.readCursor(SESSION), Option.some(cursorAt('a2', 9_000)))
      })
    )
  )
})

describe('RunEventStore.appendTranscript', () => {
  const SESSION = SessionId.make('44444444-4444-4444-8444-444444444444')
  const FILE = { fileSize: 9_000, mtimeMs: 1_762_128_000_000 }

  const entryOf = (sourceUuid: string, itemId: string) => ({
    sourceUuid,
    event: messageUpdated(itemId, sourceUuid, false)
  })
  const tailOf = (...uuids: ReadonlyArray<string>) => ({
    ...FILE,
    entries: uuids.map((uuid) => entryOf(uuid, uuid))
  })
  const numbered = (count: number) => Array.from({ length: count }, (_, index) => `u${index + 1}`)
  const cursorAt = (lastUuid: string, file: { fileSize: number; mtimeMs: number }) =>
    Option.some(TranscriptCursor.make({ sessionId: SESSION, lastUuid, ...file }))
  const eventsOf = (sql: SqlClient.SqlClient, sourceUuid: string) =>
    Effect.map(
      sql<{
        readonly n: number
      }>`SELECT COUNT(*) AS n FROM run_events WHERE source_uuid = ${sourceUuid}`,
      (rows) => rows[0].n
    )

  it.effect('skips an entry whose source uuid the agent stored under another item id', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: messageUpdated('live-1', 'u1', false), sourceUuid: 'u1' }
        ])

        yield* store.appendTranscript(AGENT_A, SESSION, tailOf('u1', 'a1'))

        const items = (yield* store.readHistory(AGENT_A)).items
        assert.deepStrictEqual(
          items.map((item) => item.itemId),
          ['live-1', 'a1']
        )
      })
    )
  )

  it.effect('moves the cursor to the last entry when every entry is already stored', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.appendTranscript(AGENT_A, SESSION, tailOf('u1', 'a1'))
        const grown = { fileSize: 12_000, mtimeMs: 1_762_128_060_000 }

        yield* store.appendTranscript(AGENT_A, SESSION, {
          ...grown,
          entries: tailOf('u1', 'a1').entries
        })

        assert.strictEqual(yield* eventCount(sql), 2)
        assert.deepStrictEqual(yield* store.readCursor(SESSION), cursorAt('a1', grown))
      })
    )
  )

  it.effect(
    'updates only the size and mtime of an existing cursor for a tail with no entries',
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          yield* store.appendTranscript(AGENT_A, SESSION, tailOf('u1', 'a1'))
          const grown = { fileSize: 9_400, mtimeMs: 1_762_128_060_000 }

          yield* store.appendTranscript(AGENT_A, SESSION, { ...grown, entries: [] })

          assert.deepStrictEqual(yield* store.readCursor(SESSION), cursorAt('a1', grown))
        })
      )
  )

  it.effect('stores no cursor for a tail with no entries when the session has none', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.appendTranscript(AGENT_A, SESSION, tailOf())

        assert.deepStrictEqual(yield* store.readCursor(SESSION), Option.none())
      })
    )
  )

  it.effect('stores every entry of a tail longer than one batch and the cursor at its end', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.appendTranscript(AGENT_A, SESSION, tailOf(...numbered(1_200)))

        assert.strictEqual(yield* eventCount(sql), 1_200)
        assert.deepStrictEqual(yield* store.readCursor(SESSION), cursorAt('u1200', FILE))
      })
    )
  )

  it.effect('keeps the batches before a failed cursor write and stores no cursor', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TEMP TRIGGER fail_cursor BEFORE INSERT ON transcript_cursors
          BEGIN SELECT RAISE(ABORT, 'x'); END`

        const error = yield* Effect.flip(
          store.appendTranscript(AGENT_A, SESSION, tailOf(...numbered(1_200)))
        )

        assert.strictEqual(error._tag, 'RunEventWriteError')
        assert.strictEqual(yield* eventCount(sql), 2 * TRANSCRIPT_BATCH_SIZE)
        assert.deepStrictEqual(yield* store.readCursor(SESSION), Option.none())
      })
    )
  )

  it.effect('keeps the batches before a failed event write and stores no cursor', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TEMP TRIGGER fail_u600 BEFORE INSERT ON run_events
          WHEN NEW.source_uuid = 'u600' BEGIN SELECT RAISE(ABORT, 'x'); END`

        const error = yield* Effect.flip(
          store.appendTranscript(AGENT_A, SESSION, tailOf(...numbered(1_200)))
        )

        assert.strictEqual(error._tag, 'RunEventWriteError')
        assert.strictEqual(yield* eventCount(sql), TRANSCRIPT_BATCH_SIZE)
        assert.deepStrictEqual(yield* store.readCursor(SESSION), Option.none())
      })
    )
  )

  it.effect('stores all events of a source uuid that straddles a batch boundary on retry', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        const uuids = [
          ...numbered(TRANSCRIPT_BATCH_SIZE - 2),
          ...Array.from({ length: 4 }, () => 'shared'),
          ...numbered(700).slice(TRANSCRIPT_BATCH_SIZE + 2)
        ]
        const tail = {
          ...FILE,
          entries: uuids.map((uuid, index) => entryOf(uuid, `item-${index}`))
        }
        yield* sql`CREATE TEMP TRIGGER fail_u600 BEFORE INSERT ON run_events
          WHEN NEW.source_uuid = 'u600' BEGIN SELECT RAISE(ABORT, 'x'); END`
        yield* Effect.flip(store.appendTranscript(AGENT_A, SESSION, tail))
        yield* sql`DROP TRIGGER fail_u600`

        yield* store.appendTranscript(AGENT_A, SESSION, tail)

        assert.strictEqual(yield* eventsOf(sql, 'shared'), 4)
        assert.strictEqual(yield* eventCount(sql), uuids.length)
      })
    )
  )
})
