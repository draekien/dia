import { Clock, Effect } from 'effect'
import { SqlClient } from 'effect/sql'

const runEach = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

const workspaceTables = runEach([
  `CREATE TABLE projects (
    project_id    TEXT    PRIMARY KEY,
    position      INTEGER NOT NULL,
    directory     TEXT    NOT NULL,
    directory_key TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL,
    is_git_repo   INTEGER NOT NULL CHECK (is_git_repo IN (0, 1))
  )`,
  `CREATE TABLE agents (
    agent_id        TEXT    PRIMARY KEY,
    project_id      TEXT    NOT NULL REFERENCES projects ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    archived        INTEGER NOT NULL CHECK (archived IN (0, 1)),
    cwd             TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    thinking_level  TEXT    NOT NULL,
    permission_mode TEXT    NOT NULL
  )`,
  `CREATE TABLE agent_worktrees (
    agent_id    TEXT PRIMARY KEY REFERENCES agents ON DELETE CASCADE,
    path        TEXT NOT NULL UNIQUE,
    branch      TEXT NOT NULL,
    source_repo TEXT NOT NULL
  )`,
  `CREATE TABLE agent_sessions (
    session_id    TEXT    PRIMARY KEY,
    agent_id      TEXT    NOT NULL REFERENCES agents ON DELETE CASCADE,
    started_at    INTEGER NOT NULL,
    superseded_at INTEGER
  )`,
  `CREATE UNIQUE INDEX agent_sessions_one_current
    ON agent_sessions (agent_id) WHERE superseded_at IS NULL`,
  `CREATE TABLE workspace_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    visible_agent TEXT REFERENCES agents ON DELETE SET NULL
  )`
])

const importResolutions = runEach([
  `CREATE TABLE import_resolutions (
    agent_id    TEXT    PRIMARY KEY,
    resolution  TEXT    NOT NULL CHECK (resolution IN ('imported', 'discarded')),
    resolved_at INTEGER NOT NULL
  )`
])

const agentEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* runEach([
    `CREATE TABLE agent_events (
      sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      item_id      TEXT,
      source_uuid  TEXT,
      occurred_at  INTEGER NOT NULL,
      payload_json TEXT    NOT NULL
    )`,
    `CREATE UNIQUE INDEX agent_events_source
      ON agent_events (agent_id, source_uuid, COALESCE(item_id, '')) WHERE source_uuid IS NOT NULL`,
    `CREATE INDEX agent_events_by_agent ON agent_events (agent_id, sequence)`,
    `CREATE TABLE agent_items (
      agent_id     TEXT    NOT NULL,
      item_id      TEXT    NOT NULL,
      position     INTEGER NOT NULL,
      kind         TEXT    NOT NULL CHECK (kind IN ('message', 'reasoning', 'tool_call')),
      streaming    INTEGER NOT NULL CHECK (streaming IN (0, 1)),
      payload_json TEXT    NOT NULL,
      PRIMARY KEY (agent_id, item_id)
    )`,
    `CREATE UNIQUE INDEX agent_items_by_position ON agent_items (agent_id, position)`,
    `CREATE TABLE agent_transcript_cursors (
      session_id TEXT    PRIMARY KEY,
      last_uuid  TEXT    NOT NULL,
      file_size  INTEGER NOT NULL,
      mtime_ms   INTEGER NOT NULL
    )`,
    `ALTER TABLE agents ADD COLUMN archived_at INTEGER`
  ])
  const now = yield* Clock.currentTimeMillis
  yield* sql.unsafe('UPDATE agents SET archived_at = ? WHERE archived = 1', [now])
  yield* sql.unsafe('ALTER TABLE agents DROP COLUMN archived')
})

const agentEventCleanup = runEach([
  `CREATE TRIGGER agents_delete_events BEFORE DELETE ON agents BEGIN
    DELETE FROM agent_transcript_cursors
      WHERE session_id IN (SELECT session_id FROM agent_sessions WHERE agent_id = OLD.agent_id);
    DELETE FROM agent_events WHERE agent_id = OLD.agent_id;
    DELETE FROM agent_items WHERE agent_id = OLD.agent_id;
  END`
])

const pathMoves = runEach([
  `CREATE TABLE data_migrations (
    plugin       TEXT    NOT NULL,
    migration_id TEXT    NOT NULL,
    ran_at       INTEGER NOT NULL,
    PRIMARY KEY (plugin, migration_id)
  )`,
  `CREATE TABLE paths_moved (
    sequence  INTEGER PRIMARY KEY AUTOINCREMENT,
    from_path TEXT    NOT NULL,
    to_path   TEXT    NOT NULL,
    moved_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE path_move_acks (
    owner    TEXT    NOT NULL,
    sequence INTEGER NOT NULL REFERENCES paths_moved,
    PRIMARY KEY (owner, sequence)
  )`
])

/**
 * The migrations of `<userData>/host.db`, keyed `<id>_<name>` and applied in id order by
 * `makeHostDatabaseLive`. Add a migration as a new key; never change an applied one.
 */
export const kernelMigrations = {
  '1_workspace': workspaceTables,
  '2_import_resolutions': importResolutions,
  '3_agent_events': agentEvents,
  '4_agent_event_cleanup': agentEventCleanup,
  '5_path_moves': pathMoves
}
