import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import {
  AgentArchived,
  AgentUnarchived,
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
import { Context, Effect, FileSystem, Layer, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { AgentEventStore, AgentEventStoreLive } from './agent-event-store'
import { makeHostDatabaseLive } from './database'

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
    store: AgentEventStore['Service'],
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, E, FileSystem.FileSystem>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-agent-event-store-' })
    const context = yield* Layer.build(
      Layer.provideMerge(AgentEventStoreLive, makeHostDatabaseLive(dir))
    )
    return yield* body(
      Context.get(context, AgentEventStore),
      Context.get(context, SqlClient.SqlClient)
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const eventCount = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM agent_events`,
    (rows) => rows[0].n
  )

const insertAgent = (sql: SqlClient.SqlClient, agentId: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO projects ${sql.insert({
      project_id: 'project',
      position: 0,
      directory: 'F:\\x',
      directory_key: 'f:\\x',
      display_name: 'x',
      is_git_repo: 0
    })}`
    yield* sql`INSERT INTO agents ${sql.insert({
      agent_id: agentId,
      project_id: 'project',
      position: 0,
      name: 'agent',
      cwd: 'F:\\x',
      model: 'claude-sonnet-5-5',
      thinking_level: 'adaptive',
      permission_mode: 'default'
    })}`
  })

const archivedAt = (sql: SqlClient.SqlClient, agentId: string) =>
  Effect.map(
    sql<{
      readonly archived_at: number | null
    }>`SELECT archived_at FROM agents WHERE agent_id = ${agentId}`,
    (rows) => rows[0].archived_at
  )

describe('AgentEventStore.append', () => {
  it.effect('keeps one item at its first position with the latest payload across updates', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, [
          { event: messageUpdated('m1', 'Hel', true) },
          { event: messageUpdated('m1', 'Hello', false) }
        ])

        const items = yield* store.readItems(AGENT_A, { limit: 10 })

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

        const items = yield* store.readItems(AGENT_A, { limit: 10 })

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
          const items = yield* store.readItems(AGENT_A, { limit: 10 })
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
        const items = yield* store.readItems(AGENT_A, { limit: 10 })
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

        const a = yield* store.readItems(AGENT_A, { limit: 10 })
        const b = yield* store.readItems(AGENT_B, { limit: 10 })

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
        yield* sql`DROP TABLE agent_items`

        const error = yield* Effect.flip(
          store.append(AGENT_A, [
            { event: SessionBound.make({ sessionId: SessionId.make('session-1') }) },
            { event: messageUpdated('m1', 'lost', false) }
          ])
        )

        assert.strictEqual(error._tag, 'AgentEventWriteError')
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

        const items = yield* store.readItems(AGENT_A, { limit: 10 })

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

        const items = yield* store.readItems(AGENT_A, { limit: 10 })

        assert.isTrue(items[0]._tag === 'ToolCallItem' && !items[0].running)
      })
    )
  )

  it.effect(
    'sets archived_at to the append time on AgentArchived and clears it on AgentUnarchived',
    () =>
      withStore((store, sql) =>
        Effect.gen(function* () {
          const archiveTime = 1_800_000_000_000
          yield* insertAgent(sql, AGENT_A)
          yield* TestClock.setTime(archiveTime)

          yield* store.append(AGENT_A, [{ event: AgentArchived.make({}) }])
          const archived = yield* archivedAt(sql, AGENT_A)
          yield* store.append(AGENT_A, [{ event: AgentUnarchived.make({}) }])
          const unarchived = yield* archivedAt(sql, AGENT_A)

          assert.deepStrictEqual([archived, unarchived], [archiveTime, null])
        })
      )
  )
})

describe('AgentEventStore.readItems', () => {
  const threeMessages = [
    { event: messageUpdated('m0', 'zero', false) },
    { event: messageUpdated('m1', 'one', false) },
    { event: messageUpdated('m2', 'two', false) }
  ]

  it.effect('returns the first page up to the limit in position order', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)

        const page = yield* store.readItems(AGENT_A, { limit: 2 })

        assert.deepStrictEqual(
          page.map((item) => item.position),
          [0, 1]
        )
      })
    )
  )

  it.effect('returns the items after the given position', () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)

        const page = yield* store.readItems(AGENT_A, { afterPosition: 1, limit: 2 })

        assert.deepStrictEqual(
          page.map((item) => item.itemId),
          ['m2']
        )
      })
    )
  )

  it.effect('leaves out a stored item that does not decode', () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        yield* store.append(AGENT_A, threeMessages)
        yield* sql`UPDATE agent_items SET payload_json = 'not json' WHERE item_id = 'm1'`

        const items = yield* store.readItems(AGENT_A, { limit: 10 })

        assert.deepStrictEqual(
          items.map((item) => item.itemId),
          ['m0', 'm2']
        )
      })
    )
  )
})
