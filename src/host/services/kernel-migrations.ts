import { Effect } from 'effect'
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

/**
 * The migrations of `<userData>/host.db`, keyed `<id>_<name>` and applied in id order by
 * `makeHostDatabaseLive`. Add a migration as a new key; never change an applied one.
 */
export const kernelMigrations = {
  '1_workspace': workspaceTables
}
