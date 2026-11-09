import type { PluginMigrations } from '@dia/plugin'
import { Effect, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { AgentDefinition, type AgentDefinitionId } from './registry'

/** A stored definition and whether it is an override of a contributed one. */
export interface StoredDefinition {
  readonly definition: AgentDefinition
  readonly override: boolean
}

/** The `agent-definitions` plugin's database migrations; pass them to `ctx.database`. */
export const agentDefinitionMigrations: PluginMigrations = {
  '1_create_definitions': Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE definitions (
      id         TEXT PRIMARY KEY,
      override   INTEGER NOT NULL CHECK (override IN (0, 1)),
      definition TEXT NOT NULL
    )`)
  })
}

const Row = Schema.Struct({
  id: Schema.String,
  override: Schema.Number,
  definition: Schema.String
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))
const decodeDefinition = Schema.decodeUnknownResult(Schema.fromJsonString(AgentDefinition))
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(AgentDefinition))

/** Every stored definition. A row that no longer decodes is left out and logged. */
export const readDefinitions: Effect.Effect<
  ReadonlyArray<StoredDefinition>,
  never,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* decodeRows(yield* sql`SELECT id, override, definition FROM definitions`)
  const stored: Array<StoredDefinition> = []
  for (const row of rows) {
    const definition = decodeDefinition(row.definition)
    if (Result.isSuccess(definition))
      stored.push({ definition: definition.success, override: row.override === 1 })
    else
      yield* Effect.logWarning('Stored agent definition skipped', {
        id: row.id,
        message: definition.failure.message
      })
  }
  return stored
}).pipe(Effect.orDie)

/** Inserts `entry`, or replaces the row with the same id. */
export const saveDefinition = (
  entry: StoredDefinition
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO definitions ${sql.insert({
      id: entry.definition.id,
      override: entry.override ? 1 : 0,
      definition: encodeDefinition(entry.definition)
    })} ON CONFLICT (id) DO UPDATE SET override = excluded.override, definition = excluded.definition`
  }).pipe(Effect.orDie)

/** Deletes the row with `id`. */
export const deleteDefinition = (
  id: AgentDefinitionId
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM definitions WHERE id = ${id}`
  }).pipe(Effect.orDie)
