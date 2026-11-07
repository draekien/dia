import type { PluginMigrations } from '@dia/plugin'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { BUILT_IN_JOB_TITLES, DEFAULT_OVERALL_CAP } from './built-in-job-titles'
import { JOB_TITLE_NAME_MAX_LENGTH, JobTitle } from './domain'

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE roles (
    role_id       TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    built_in      TEXT    UNIQUE CHECK (built_in IN ('planner', 'engineer', 'reviewer', 'researcher', 'retro')),
    enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    instructions  TEXT    NOT NULL,
    skills        TEXT    NOT NULL,
    permissions   TEXT    NOT NULL,
    mcp_servers   TEXT    NOT NULL,
    bypass_opt_in INTEGER NOT NULL CHECK (bypass_opt_in IN (0, 1))
  )`)
  yield* sql.unsafe(`CREATE TABLE hired_agents (
    hire_id         TEXT    PRIMARY KEY,
    role_id         TEXT    NOT NULL REFERENCES roles,
    name            TEXT    UNIQUE COLLATE NOCASE,
    bypass_override INTEGER CHECK (bypass_override IN (0, 1)),
    hired_at        INTEGER NOT NULL
  )`)
  yield* sql.unsafe(`CREATE TABLE org_settings (
    singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
    overall_cap INTEGER NOT NULL CHECK (overall_cap >= 1)
  )`)
})

const seedOrgSettings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO org_settings ${sql.insert({ singleton: 1, overall_cap: DEFAULT_OVERALL_CAP })}`
})

const encodePermissions = Schema.encodeSync(Schema.fromJsonString(JobTitle.fields.permissions))

interface CopiedRole {
  readonly role_id: string
  readonly name: string
  readonly enabled: number
  readonly instructions: string
  readonly skills: string
  readonly permissions: string
  readonly mcp_servers: string
  readonly bypass_opt_in: number
}

const freeName = (name: string, taken: ReadonlySet<string>): string => {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? ' (old)' : ` (old ${n})`
    const candidate = `${name.slice(0, JOB_TITLE_NAME_MAX_LENGTH - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

const namesForCopies = (copies: ReadonlyArray<CopiedRole>): ReadonlyMap<string, string> => {
  const builtInNames = new Set(BUILT_IN_JOB_TITLES.map((seed) => seed.name.toLowerCase()))
  const clashes = copies.filter((copy) => builtInNames.has(copy.name.toLowerCase()))
  const taken = new Set([
    ...builtInNames,
    ...copies.filter((copy) => !clashes.includes(copy)).map((copy) => copy.name.toLowerCase())
  ])
  const names = new Map(copies.map((copy) => [copy.role_id, copy.name]))
  for (const copy of clashes) {
    const name = freeName(copy.name, taken)
    taken.add(name.toLowerCase())
    names.set(copy.role_id, name)
  }
  return names
}

const moveToJobTitles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE job_titles (
    job_title_id    TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    built_in        TEXT    UNIQUE CHECK (built_in IN ('product-manager', 'software-engineer', 'quality-engineer', 'business-analyst', 'ui-ux', 'team-lead', 'technical-lead')),
    enabled         INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    job_description TEXT    NOT NULL,
    skills          TEXT    NOT NULL,
    permissions     TEXT    NOT NULL,
    mcp_servers     TEXT    NOT NULL,
    bypass_opt_in   INTEGER NOT NULL CHECK (bypass_opt_in IN (0, 1))
  )`)
  for (const seed of BUILT_IN_JOB_TITLES) {
    yield* sql`INSERT INTO job_titles ${sql.insert({
      job_title_id: seed.id,
      name: seed.name,
      built_in: seed.kind,
      enabled: 1,
      job_description: seed.jobDescription,
      skills: '[]',
      permissions: encodePermissions({ allow: [], ask: [], deny: seed.deny }),
      mcp_servers: '{}',
      bypass_opt_in: 0
    })}`
  }
  const copies = yield* sql<CopiedRole>`SELECT role_id, name, enabled, instructions, skills,
    permissions, mcp_servers, bypass_opt_in FROM roles WHERE built_in IS NULL ORDER BY rowid`
  const names = namesForCopies(copies)
  for (const copy of copies) {
    yield* sql`INSERT INTO job_titles ${sql.insert({
      job_title_id: copy.role_id,
      name: names.get(copy.role_id) ?? copy.name,
      built_in: null,
      enabled: copy.enabled,
      job_description: copy.instructions,
      skills: copy.skills,
      permissions: copy.permissions,
      mcp_servers: copy.mcp_servers,
      bypass_opt_in: copy.bypass_opt_in
    })}`
  }
  yield* sql.unsafe(`CREATE TABLE hired_agents_next (
    hire_id         TEXT    PRIMARY KEY,
    job_title_id    TEXT    NOT NULL REFERENCES job_titles,
    name            TEXT    UNIQUE COLLATE NOCASE,
    bypass_override INTEGER CHECK (bypass_override IN (0, 1)),
    hired_at        INTEGER NOT NULL
  )`)
  yield* sql.unsafe(`INSERT INTO hired_agents_next (hire_id, job_title_id, name, bypass_override, hired_at)
    SELECT hire_id, role_id, name, bypass_override, hired_at FROM hired_agents
    WHERE role_id IN (SELECT role_id FROM roles WHERE built_in IS NULL) ORDER BY rowid`)
  const [counts] = yield* sql<{ readonly all: number; readonly copied: number }>`SELECT
    (SELECT count(*) FROM hired_agents) AS "all", (SELECT count(*) FROM hired_agents_next) AS copied`
  yield* sql.unsafe('DROP TABLE hired_agents')
  yield* sql.unsafe('DROP TABLE roles')
  yield* sql.unsafe('ALTER TABLE hired_agents_next RENAME TO hired_agents')
  yield* Effect.logInfo('Moved the org to job titles', {
    copiedJobTitles: copies.length,
    copiedHires: counts?.copied ?? 0,
    droppedHires: (counts?.all ?? 0) - (counts?.copied ?? 0)
  })
})

const addReportsTo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(
    'ALTER TABLE hired_agents ADD COLUMN reports_to TEXT REFERENCES hired_agents(hire_id)'
  )
  yield* Effect.logInfo('Added reporting lines to hired agents')
})

const addJobTitleModel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe('ALTER TABLE job_titles ADD COLUMN model TEXT')
  yield* sql.unsafe(
    "ALTER TABLE job_titles ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'medium'"
  )
  yield* Effect.logInfo('Added a model and thinking level to job titles')
})

const createObjectivesAndTasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE org_events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    at           INTEGER NOT NULL,
    objective_id TEXT    NOT NULL,
    task_id      TEXT,
    event        TEXT    NOT NULL
  )`)
  yield* sql.unsafe(`CREATE TABLE objectives (
    objective_id TEXT    PRIMARY KEY,
    project_id   TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL,
    priority     TEXT    NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
    assignee     TEXT    REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
    state        TEXT    NOT NULL CHECK (state IN ('open', 'completed')),
    created_at   INTEGER NOT NULL
  )`)
  yield* sql.unsafe(`CREATE TABLE tasks (
    task_id        TEXT    PRIMARY KEY,
    objective_id   TEXT    NOT NULL REFERENCES objectives,
    parent_task_id TEXT    REFERENCES tasks(task_id),
    kind           TEXT    NOT NULL CHECK (kind IN ('work', 'retro')),
    title          TEXT    NOT NULL,
    state          TEXT    NOT NULL CHECK (state IN ('waiting', 'running', 'finished', 'completed')),
    assignee       TEXT    REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
    pane_id        TEXT    NOT NULL UNIQUE,
    session_id     TEXT,
    created_at     INTEGER NOT NULL
  )`)
  yield* Effect.logInfo('Created the objectives, tasks and org events tables')
})

/**
 * The `org` plugin's migrations, passed to `ctx.database`. `1_create_org_tables` creates the
 * first roles, hired agents and org settings tables; `2_seed_org` inserts the default overall cap;
 * `3_job_titles` replaces the roles table with the job titles table, inserts the built-in job
 * titles, keeps the user's copies and their hires, and drops the five old built-in roles and their
 * hires; `4_add_reports_to` adds each hired agent's `reportsTo`, null for existing hires;
 * `5_job_title_model` adds each job title's model, null, and thinking level, `medium`;
 * `6_objectives_tasks` creates the objectives and tasks tables and the event table that records
 * their changes. Each runs once per database.
 */
export const orgMigrations: PluginMigrations = {
  '1_create_org_tables': createTables,
  '2_seed_org': seedOrgSettings,
  '3_job_titles': moveToJobTitles,
  '4_add_reports_to': addReportsTo,
  '5_job_title_model': addJobTitleModel,
  '6_objectives_tasks': createObjectivesAndTasks
}
