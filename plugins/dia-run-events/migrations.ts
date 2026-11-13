import type { PluginMigrations } from '@dia/plugin'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const statement of [
    `CREATE TABLE run_events (
      sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      item_id      TEXT,
      source_uuid  TEXT,
      occurred_at  INTEGER NOT NULL,
      payload_json TEXT    NOT NULL
    )`,
    `CREATE UNIQUE INDEX run_events_source
      ON run_events (run_id, source_uuid, COALESCE(item_id, '')) WHERE source_uuid IS NOT NULL`,
    'CREATE INDEX run_events_by_run ON run_events (run_id, sequence)',
    `CREATE TABLE run_items (
      run_id       TEXT    NOT NULL,
      item_id      TEXT    NOT NULL,
      position     INTEGER NOT NULL,
      kind         TEXT    NOT NULL CHECK (kind IN ('message', 'reasoning', 'tool_call')),
      streaming    INTEGER NOT NULL CHECK (streaming IN (0, 1)),
      payload_json TEXT    NOT NULL,
      PRIMARY KEY (run_id, item_id)
    )`,
    'CREATE UNIQUE INDEX run_items_by_position ON run_items (run_id, position)',
    `CREATE TABLE transcript_cursors (
      session_id TEXT    PRIMARY KEY,
      last_uuid  TEXT    NOT NULL,
      file_size  INTEGER NOT NULL,
      mtime_ms   INTEGER NOT NULL
    )`,
    `CREATE TABLE handover (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      copied_at INTEGER NOT NULL
    )`
  ]) {
    yield* sql.unsafe(statement)
  }
  yield* Effect.logInfo('Created the run event tables')
})

/**
 * The `dia-run-events` plugin's migrations, passed to `ctx.database`. `1_create_run_events` creates
 * the run event log (`run_events`), its item projection (`run_items`), the transcript cursors and
 * the `handover` row that records the one-time copy from `host.db`. No trigger deletes an event.
 */
export const runEventsMigrations: PluginMigrations = {
  '1_create_run_events': createTables
}
