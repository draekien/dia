import type { PluginMigrations } from '@dia/plugin'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

const createSchedules = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE schedules (
    id              TEXT    PRIMARY KEY,
    definition_json TEXT    NOT NULL,
    fired_at        INTEGER NOT NULL
  )`)
  yield* Effect.logInfo('Created the schedules table')
})

/**
 * The `dia-schedules` plugin's migrations, passed to `ctx.database`. `1_create_schedules` creates
 * `schedules`: each schedule's definition and when it last fired (or was stored), in epoch
 * milliseconds.
 */
export const schedulesMigrations: PluginMigrations = {
  '1_create_schedules': createSchedules
}
