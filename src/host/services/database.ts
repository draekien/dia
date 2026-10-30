import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node'
import { PluginDatabaseError, type PluginMigrations } from '@shared/plugin/api'
import { Context, Data, Effect, Exit, Layer, Scope } from 'effect'
import { SqlClient } from 'effect/sql'

type Migrations = Readonly<Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>>

const MIGRATION_KEY = /^(\d+)_(.+)$/

const kernelMigrations: Migrations = {}

/**
 * Failure of {@link openDatabase} when a migration key does not match `<id>_<name>` or two keys
 * share an id. Carries the file and the offending key.
 */
export class InvalidMigrationKeyError extends Data.TaggedError('InvalidMigrationKeyError')<{
  readonly filename: string
  readonly key: string
}> {
  override get message() {
    return `Migration key "${this.key}" in ${this.filename} is not <id>_<name>, or its id repeats`
  }
}

const checkKeys = Effect.fnUntraced(function* (filename: string, migrations: Migrations) {
  const seen = new Set<number>()
  for (const key of Object.keys(migrations)) {
    const id = key.match(MIGRATION_KEY)?.[1]
    if (id === undefined || seen.has(Number(id))) {
      return yield* new InvalidMigrationKeyError({ filename, key })
    }
    seen.add(Number(id))
  }
})

/**
 * Opens the SQLite file at `filename` with write-ahead journaling and a busy timeout, applies
 * `migrations`, and returns a client. The connection closes when the surrounding scope closes.
 * Checks every key before opening the file. Fails with {@link InvalidMigrationKeyError} for a
 * malformed or duplicate key, `SqlError` when the file cannot be opened, and `MigrationError`
 * when a migration fails; pending migrations run in one transaction, so a failure applies none of them.
 */
export const openDatabase = Effect.fn('openDatabase')(
  function* (filename: string, migrations: Migrations) {
    yield* checkKeys(filename, migrations)
    const connection = yield* Scope.fork(yield* Effect.scope)
    const { sql, applied } = yield* Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(SqliteClient.layer({ filename }), connection)
      const sql = Context.get(context, SqlClient.SqlClient)
      const applied = yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord(migrations)
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      return { sql, applied }
    }).pipe(Effect.onError((cause) => Scope.close(connection, Exit.failCause(cause))))
    yield* Effect.logInfo('Opened database', {
      filename,
      applied: applied.map(([id, name]) => `${id}_${name}`)
    })
    return sql
  },
  (effect, filename) =>
    Effect.tapError(effect, (error) =>
      Effect.logError('Could not open database', {
        filename,
        message: error.message,
        cause: error.cause
      })
    )
)

/**
 * Provides `SqlClient` for `<userDataPath>/host.db` with the kernel migrations applied. A Host
 * service that keeps runtime state across a restart requires `SqlClient` from this layer.
 * Building it fails, and the Host does not start, when the file cannot be opened or a migration
 * fails.
 */
export const makeHostDatabaseLive = (userDataPath: string) =>
  Layer.effect(SqlClient.SqlClient, openDatabase(`${userDataPath}/host.db`, kernelMigrations))

/**
 * Builds the `database` member of a plugin's context for the file `filename`, owned by the plugin
 * named `plugin`. The returned function opens the file in the caller's scope with the given
 * migrations and fails with `PluginDatabaseError`; calling it a second time is a defect.
 */
export const makePluginDatabase = (filename: string, plugin: string) => {
  let opened = false
  return (migrations: PluginMigrations) =>
    Effect.gen(function* () {
      if (opened) {
        return yield* Effect.die(new Error(`${plugin} called ctx.database twice in one setup`))
      }
      opened = true
      return yield* openDatabase(filename, migrations)
    }).pipe(
      Effect.mapError((error) => new PluginDatabaseError({ filename, message: error.message })),
      Effect.annotateLogs({ plugin })
    )
}
