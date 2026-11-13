import type { PluginMigrations } from '@dia/plugin'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const statement of [
    `CREATE TABLE runs (
      run_id     TEXT    PRIMARY KEY,
      spec_json  TEXT    NOT NULL,
      session_id TEXT,
      status     TEXT    NOT NULL CHECK (status IN ('idle', 'running', 'waiting', 'archived')),
      has_tab    INTEGER NOT NULL CHECK (has_tab IN (0, 1)),
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE applied_calls (
      request_id TEXT    PRIMARY KEY,
      run_id     TEXT    NOT NULL,
      tag        TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
    `CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    )`
  ]) {
    yield* sql.unsafe(statement)
  }
  yield* Effect.logInfo('Created the run tables')
})

/**
 * The `dia-runs` plugin's migrations, passed to `ctx.database`. `1_create_runs` creates the run
 * rows (`runs`), the ids of session calls already applied (`applied_calls`) and the plugin's
 * settings (`settings`).
 */
export const runsMigrations: PluginMigrations = {
  '1_create_runs': createTables
}
