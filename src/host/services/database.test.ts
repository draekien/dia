import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Cause, Context, Data, Effect, Exit, FileSystem, Layer, Path, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { makeHostDatabaseLive, makePluginDatabase, openDatabase } from './database'
import { kernelMigrations } from './kernel-migrations'

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const createTable = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE ${sql(table)} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`
  })

class MigrationExploded extends Data.TaggedError('MigrationExploded') {}

const failing = Effect.fail(new MigrationExploded())

const tempFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped()
  return { dir, filename: path.join(dir, 'test.db') }
})

const tableNames = (sql: SqlClient.SqlClient) =>
  sql<{
    name: string
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'effect_%' ORDER BY name`.pipe(
    Effect.map((rows) => rows.map((row) => row.name))
  )

const openIn = (filename: string, migrations: Parameters<typeof openDatabase>[1]) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const sql = yield* openDatabase(filename, migrations).pipe(Scope.provide(scope))
    return { sql, close: Scope.close(scope, Exit.void) }
  })

describe('openDatabase', () => {
  it.effect(
    'applies each migration once across reopenings and keeps the rows written in between',
    () =>
      Effect.gen(function* () {
        const { filename } = yield* tempFile
        const migrations = { '1_create_notes': createTable('notes') }

        const first = yield* openIn(filename, migrations)
        yield* first.sql`INSERT INTO notes (value) VALUES ('kept')`
        yield* first.close

        const second = yield* openIn(filename, migrations)
        const rows = yield* second.sql<{ value: string }>`SELECT value FROM notes`
        yield* second.close

        assert.deepStrictEqual(
          rows.map((row) => row.value),
          ['kept']
        )
      }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('applies a migration added after the first opening', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile
      const first = yield* openIn(filename, { '1_create_notes': createTable('notes') })
      yield* first.close

      const second = yield* openIn(filename, {
        '1_create_notes': createTable('notes'),
        '2_create_tags': createTable('tags')
      })
      const tables = yield* tableNames(second.sql)
      yield* second.close

      assert.deepStrictEqual(tables, ['notes', 'tags'])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('opens the file with write-ahead journaling', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile
      const db = yield* openIn(filename, {})
      const rows = yield* db.sql<{ journal_mode: string }>`PRAGMA journal_mode`
      yield* db.close

      assert.strictEqual(rows[0]?.journal_mode, 'wal')
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('releases the file when its scope closes, leaving no -wal or -shm file', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { dir, filename } = yield* tempFile
      const db = yield* openIn(filename, { '1_create_notes': createTable('notes') })
      yield* db.sql`INSERT INTO notes (value) VALUES ('x')`
      yield* db.close

      const remaining = yield* fs.readDirectory(dir)
      yield* fs.remove(filename)

      assert.deepStrictEqual(remaining, ['test.db'])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('applies none of a run when one of its migrations fails', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile
      const exit = yield* openIn(filename, {
        '1_create_notes': createTable('notes'),
        '2_explode': failing
      }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))

      const db = yield* openIn(filename, {})
      const tables = yield* tableNames(db.sql)
      yield* db.close

      assert.deepStrictEqual(tables, [])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('rejects a key without an id before creating the file', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { filename } = yield* tempFile

      const error = yield* openIn(filename, { create_notes: createTable('notes') }).pipe(
        Effect.flip
      )

      assert.strictEqual(error._tag, 'InvalidMigrationKeyError')
      assert.isFalse(yield* fs.exists(filename))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('rejects two keys that share a numeric id', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile

      const error = yield* openIn(filename, {
        '1_create_notes': createTable('notes'),
        '01_create_tags': createTable('tags')
      }).pipe(Effect.flip)

      assert.strictEqual(error._tag, 'InvalidMigrationKeyError')
    }).pipe(Effect.scoped, Effect.provide(platform))
  )
})

describe('makePluginDatabase', () => {
  it.effect('maps a malformed key to a PluginDatabaseError whose message names the key', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile
      const database = makePluginDatabase(filename, 'notes-plugin')

      const error = yield* database({
        // @ts-expect-error a key without an id is what this test feeds in
        create_notes: createTable('notes')
      }).pipe(Effect.scoped, Effect.flip)

      assert.strictEqual(error._tag, 'PluginDatabaseError')
      assert.strictEqual(error.filename, filename)
      assert.include(error.message, 'create_notes')
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('maps a failing migration to a PluginDatabaseError', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile
      const database = makePluginDatabase(filename, 'notes-plugin')

      const error = yield* database({ '1_explode': failing }).pipe(Effect.scoped, Effect.flip)

      assert.strictEqual(error._tag, 'PluginDatabaseError')
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('dies on a second call, naming the plugin, even after the first call failed', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile
      const database = makePluginDatabase(filename, 'notes-plugin')
      yield* database({ '1_explode': failing }).pipe(Effect.scoped, Effect.exit)

      const exit = yield* database({}).pipe(Effect.scoped, Effect.exit)

      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      assert.include(
        String(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)),
        'notes-plugin'
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('creates no file until the plugin calls it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { filename } = yield* tempFile

      makePluginDatabase(filename, 'notes-plugin')

      assert.isFalse(yield* fs.exists(filename))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('returns a client on the plugin file with its migrations applied', () =>
    Effect.gen(function* () {
      const { filename } = yield* tempFile
      const database = makePluginDatabase(filename, 'notes-plugin')

      const tables = yield* Effect.gen(function* () {
        const sql = yield* database({ '1_create_notes': createTable('notes') })
        return yield* tableNames(sql)
      }).pipe(Effect.scoped)

      assert.deepStrictEqual(tables, ['notes'])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )
})

describe('makeHostDatabaseLive', () => {
  const openHostDatabase = (dir: string) =>
    Effect.map(Layer.build(makeHostDatabaseLive(dir)), (context) =>
      Context.get(context, SqlClient.SqlClient)
    )

  const insertAgentAtMigration2 = (sql: SqlClient.SqlClient, agentId: string, archived: 0 | 1) =>
    sql`INSERT INTO agents ${sql.insert({
      agent_id: agentId,
      project_id: 'project',
      position: 0,
      name: agentId,
      archived,
      cwd: 'F:\\x',
      model: 'claude-sonnet-5-5',
      thinking_level: 'adaptive',
      permission_mode: 'default'
    })}`

  it.effect('creates the agent event tables in a new host.db', () =>
    Effect.gen(function* () {
      const { dir } = yield* tempFile
      const sql = yield* openHostDatabase(dir)

      const tables = yield* tableNames(sql)

      assert.includeMembers(tables, ['agent_events', 'agent_items', 'agent_transcript_cursors'])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('opens host.db with write-ahead journaling and synchronous NORMAL', () =>
    Effect.gen(function* () {
      const { dir } = yield* tempFile
      const sql = yield* openHostDatabase(dir)

      const journal = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`
      const synchronous = yield* sql<{ synchronous: number }>`PRAGMA synchronous`

      const NORMAL = 1
      assert.deepStrictEqual(
        [journal[0]?.journal_mode, synchronous[0]?.synchronous],
        ['wal', NORMAL]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect(
    'gives an agent archived before the upgrade the upgrade time and keeps an active one unarchived',
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const { dir } = yield* tempFile
        const upgradeTime = 1_800_000_000_000
        const before = yield* openIn(path.join(dir, 'host.db'), {
          '1_workspace': kernelMigrations['1_workspace'],
          '2_import_resolutions': kernelMigrations['2_import_resolutions']
        })
        yield* before.sql`INSERT INTO projects ${before.sql.insert({
          project_id: 'project',
          position: 0,
          directory: 'F:\\x',
          directory_key: 'f:\\x',
          display_name: 'x',
          is_git_repo: 0
        })}`
        yield* insertAgentAtMigration2(before.sql, 'archived-agent', 1)
        yield* insertAgentAtMigration2(before.sql, 'active-agent', 0)
        yield* before.close
        yield* TestClock.setTime(upgradeTime)

        const sql = yield* openHostDatabase(dir)
        const rows = yield* sql<{
          agent_id: string
          archived_at: number | null
        }>`SELECT agent_id, archived_at FROM agents ORDER BY agent_id`

        assert.deepStrictEqual(
          rows.map((row) => [row.agent_id, row.archived_at]),
          [
            ['active-agent', null],
            ['archived-agent', upgradeTime]
          ]
        )
      }).pipe(Effect.scoped, Effect.provide(platform))
  )
})
