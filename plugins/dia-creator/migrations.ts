import type { PluginMigrations } from '@dia/plugin'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE creator_runs (
    run_id         TEXT    PRIMARY KEY,
    last_sequence  INTEGER NOT NULL,
    worktree       TEXT    NOT NULL,
    last_merge_sha TEXT
  )`)
  yield* sql.unsafe(`CREATE TABLE creator_turns (
    run_id      TEXT NOT NULL REFERENCES creator_runs ON DELETE CASCADE,
    turn_id     TEXT NOT NULL,
    position    INTEGER NOT NULL,
    message_ids TEXT NOT NULL,
    from_sha    TEXT NOT NULL,
    to_sha      TEXT,
    commits     TEXT NOT NULL,
    plugins     TEXT NOT NULL,
    loads       TEXT NOT NULL,
    revert_sha  TEXT,
    PRIMARY KEY (run_id, turn_id)
  )`)
})

/**
 * The dia-creator database: `creator_runs` holds each Creator run's worktree as JSON, the last run
 * event sequence folded, and its latest merge commit; `creator_turns` holds each turn's commit
 * range, commits, the plugins its `plugin_*` calls named, their load outcomes, and its revert.
 */
export const creatorMigrations: PluginMigrations = {
  '1_create_creator_tables': createTables
}
