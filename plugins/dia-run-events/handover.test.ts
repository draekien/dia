import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { MessageUpdated } from '@shared/domain/agent-event'
import { SessionId } from '@shared/domain/pane'
import { Effect, FileSystem, Option, Schema, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { kernelMigrations } from '../../src/host/services/kernel-migrations'
import { StoredEvent, TranscriptCursor } from '../../src/host/services/run-events-seam'
import { handOverFromHostDatabase } from './handover'
import { runEventsMigrations } from './migrations'
import { RunEventStore, RunEventStoreLive } from './store'

const TAB = '11111111-1111-4111-8111-111111111111'
const SESSION = SessionId.make('33333333-3333-4333-8333-333333333333')

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(StoredEvent))

const reply = (itemId: string, content: string) =>
  MessageUpdated.make({ itemId, message: { role: 'assistant', content }, streaming: false })

const LEGACY_EVENTS = [
  { sequence: 4, event: reply('m1', 'first') },
  { sequence: 9, event: reply('m2', 'second') }
]

const CURSOR = TranscriptCursor.make({
  sessionId: SESSION,
  lastUuid: 'u9',
  fileSize: 4_821,
  mtimeMs: 1_762_128_000_000
})

const writeLegacyEvent = (
  sql: SqlClient.SqlClient,
  { sequence, event }: { readonly sequence: number; readonly event: MessageUpdated },
  position: number
) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO agent_events ${sql.insert({
      sequence,
      agent_id: TAB,
      event_type: event._tag,
      item_id: event.itemId,
      source_uuid: null,
      occurred_at: 1_762_128_000_000,
      payload_json: encodeEvent(event)
    })}`
    yield* sql`INSERT INTO agent_items ${sql.insert({
      agent_id: TAB,
      item_id: event.itemId,
      position,
      kind: 'message',
      streaming: 0,
      payload_json: JSON.stringify({ message: event.message })
    })}`
  })

const legacyHostDatabase = (dir: string) =>
  Effect.gen(function* () {
    const sql = yield* openDatabase(`${dir}/host.db`, kernelMigrations)
    for (const [position, legacy] of LEGACY_EVENTS.entries()) {
      yield* writeLegacyEvent(sql, legacy, position)
    }
    yield* sql`INSERT INTO agent_transcript_cursors ${sql.insert({
      session_id: CURSOR.sessionId,
      last_uuid: CURSOR.lastUuid,
      file_size: CURSOR.fileSize,
      mtime_ms: CURSOR.mtimeMs
    })}`
    return sql
  })

const pluginDataDir = (dir: string) => `${dir}/plugins/dia-run-events`

const openPluginDatabase = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(pluginDataDir(dir), { recursive: true })
    return yield* openDatabase(`${pluginDataDir(dir)}/data.db`, runEventsMigrations)
  })

const handOver = (dir: string, sql: SqlClient.SqlClient) =>
  handOverFromHostDatabase(`${pluginDataDir(dir)}/../../host.db`).pipe(
    Effect.provideService(SqlClient.SqlClient, sql)
  )

const storeOver = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    return yield* RunEventStore
  }).pipe(Effect.provide(RunEventStoreLive), Effect.provideService(SqlClient.SqlClient, sql))

const countOf = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`,
    (rows) => rows[0].n
  )

const inTempDir = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-run-events-handover-' })
    return yield* body(dir)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('handOverFromHostDatabase', () => {
  it.effect('copies the history of a tab so the store reads the same items', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* legacyHostDatabase(dir)
        const sql = yield* openPluginDatabase(dir)

        yield* handOver(dir, sql)

        const { items } = yield* (yield* storeOver(sql)).readHistory(TAB)
        assert.deepStrictEqual(
          items.map((item) => (item._tag === 'MessageItem' ? item.message.content : item._tag)),
          ['first', 'second']
        )
      })
    )
  )

  it.effect('keeps each copied event under its sequence', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* legacyHostDatabase(dir)
        const sql = yield* openPluginDatabase(dir)

        yield* handOver(dir, sql)

        const replay = yield* (yield* storeOver(sql)).readAfter(TAB, 0, {
          maxEvents: 100,
          maxBytes: 1_000_000
        })
        assert.deepStrictEqual(
          replay._tag === 'Replay'
            ? replay.events.map(({ sequence, event }) => ({ sequence, event }))
            : replay,
          LEGACY_EVENTS
        )
      })
    )
  )

  it.effect('copies the transcript cursors', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* legacyHostDatabase(dir)
        const sql = yield* openPluginDatabase(dir)

        yield* handOver(dir, sql)

        assert.deepStrictEqual(
          yield* (yield* storeOver(sql)).readCursor(SESSION),
          Option.some(CURSOR)
        )
      })
    )
  )

  it.effect('numbers the first event appended after the copy above every copied sequence', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* legacyHostDatabase(dir)
        const sql = yield* openPluginDatabase(dir)
        yield* handOver(dir, sql)

        const [appended] = yield* (yield* storeOver(sql)).append(TAB, [
          { event: reply('m3', 'third') }
        ])

        const highestCopied = Math.max(...LEGACY_EVENTS.map(({ sequence }) => sequence))
        assert.isTrue(Option.getOrThrow(appended) > highestCopied)
      })
    )
  )

  it.effect('copies nothing on a later start, even rows host.db gained since', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const host = yield* legacyHostDatabase(dir)
        const sql = yield* openPluginDatabase(dir)
        yield* handOver(dir, sql)
        yield* writeLegacyEvent(host, { sequence: 20, event: reply('m9', 'late') }, 2)

        yield* handOver(dir, sql)
        yield* handOver(dir, sql)

        assert.deepStrictEqual(
          [yield* countOf(sql, 'run_events'), yield* countOf(sql, 'run_items')],
          [LEGACY_EVENTS.length, LEGACY_EVENTS.length]
        )
      })
    )
  )

  it.effect('copies nothing and does not look again when there is no host.db', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const sql = yield* openPluginDatabase(dir)
        yield* handOver(dir, sql)
        yield* legacyHostDatabase(dir)

        yield* handOver(dir, sql)

        assert.strictEqual(yield* countOf(sql, 'run_events'), 0)
      })
    )
  )

  it.effect('copies nothing when a row collides, and copies all of it on the next start', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* legacyHostDatabase(dir)
        const sql = yield* openPluginDatabase(dir)
        yield* sql`INSERT INTO transcript_cursors ${sql.insert({
          session_id: SESSION,
          last_uuid: 'blocking',
          file_size: 0,
          mtime_ms: 0
        })}`

        const failed = yield* Effect.exit(handOver(dir, sql))
        const afterFailure = yield* countOf(sql, 'run_events')
        yield* sql`DELETE FROM transcript_cursors`
        yield* handOver(dir, sql)

        assert.strictEqual(failed._tag, 'Failure')
        assert.deepStrictEqual(
          [afterFailure, yield* countOf(sql, 'run_events')],
          [0, LEGACY_EVENTS.length]
        )
      })
    )
  )
})
