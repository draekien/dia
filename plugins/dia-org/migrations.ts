import type { PluginMigrations } from '@dia/plugin'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  BUILT_IN_JOB_TITLES,
  DEFAULT_OVERALL_CAP,
  EXECUTIVE_ASSISTANT,
  ISSUE_TOOLS
} from './built-in-job-titles'
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

const PermissionsJson = Schema.fromJsonString(JobTitle.fields.permissions)
const encodePermissions = Schema.encodeSync(PermissionsJson)
const decodePermissions = Schema.decodeUnknownEffect(PermissionsJson)

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

const allowIssueToolsOnBuiltIns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly job_title_id: string
    readonly permissions: string
  }>`SELECT job_title_id, permissions FROM job_titles WHERE built_in IS NOT NULL`
  for (const row of rows) {
    const permissions = yield* decodePermissions(row.permissions).pipe(Effect.orDie)
    const allow = [
      ...permissions.allow,
      ...ISSUE_TOOLS.filter((tool) => !permissions.allow.includes(tool))
    ]
    yield* sql`UPDATE job_titles SET permissions = ${encodePermissions({ ...permissions, allow })} WHERE job_title_id = ${row.job_title_id}`
  }
  return rows.length
})

const moveToIssues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE issues (
    issue_id        TEXT    PRIMARY KEY,
    objective_id    TEXT    NOT NULL REFERENCES objectives,
    parent_issue_id TEXT    REFERENCES issues(issue_id),
    kind            TEXT    NOT NULL CHECK (kind IN ('work', 'retro', 'planning')),
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL CHECK (status IN ('triage','todo','understanding','designing','implementing','testing','verifying','in_review','done','canceled')),
    assignee        TEXT    REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
    pane_id         TEXT    NOT NULL UNIQUE,
    session_id      TEXT,
    created_at      INTEGER NOT NULL
  )`)
  yield* sql.unsafe(`INSERT INTO issues (issue_id, objective_id, parent_issue_id, kind, title, status, assignee, pane_id, session_id, created_at)
    SELECT task_id, objective_id, parent_task_id, kind, title,
           CASE state WHEN 'waiting' THEN 'todo' WHEN 'running' THEN 'todo' ELSE 'done' END,
           assignee, pane_id, session_id, created_at
    FROM tasks ORDER BY rowid`)
  yield* sql.unsafe('DROP TABLE tasks')
  yield* sql.unsafe('CREATE INDEX issues_objective ON issues(objective_id)')
  yield* sql.unsafe('CREATE INDEX issues_status_assignee ON issues(status, assignee)')
  yield* sql.unsafe(`CREATE TABLE issue_comments (
    comment_id TEXT    PRIMARY KEY,
    issue_id   TEXT    NOT NULL REFERENCES issues,
    author     TEXT    REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  yield* sql.unsafe('CREATE INDEX issue_comments_issue ON issue_comments(issue_id)')
  yield* sql.unsafe('ALTER TABLE org_events RENAME COLUMN task_id TO issue_id')
  const builtIns = yield* allowIssueToolsOnBuiltIns
  yield* Effect.logInfo('Moved org tasks to issues', {
    builtInJobTitlesAllowingIssueTools: builtIns
  })
})

const BUILT_IN_KINDS = [...BUILT_IN_JOB_TITLES.map((seed) => seed.kind), EXECUTIVE_ASSISTANT.kind]

const addExecutiveAssistant = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe('PRAGMA defer_foreign_keys = ON')
  yield* sql.unsafe('CREATE TEMP TABLE job_titles_before AS SELECT * FROM job_titles')
  yield* sql.unsafe('DROP TABLE job_titles')
  yield* sql.unsafe(`CREATE TABLE job_titles (
    job_title_id    TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    built_in        TEXT    UNIQUE CHECK (built_in IN (${BUILT_IN_KINDS.map((kind) => `'${kind}'`).join(', ')})),
    enabled         INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    job_description TEXT    NOT NULL,
    skills          TEXT    NOT NULL,
    permissions     TEXT    NOT NULL,
    mcp_servers     TEXT    NOT NULL,
    bypass_opt_in   INTEGER NOT NULL CHECK (bypass_opt_in IN (0, 1)),
    model           TEXT,
    thinking_level  TEXT    NOT NULL DEFAULT 'medium'
  )`)
  yield* sql.unsafe(`INSERT INTO job_titles (job_title_id, name, built_in, enabled, job_description,
    skills, permissions, mcp_servers, bypass_opt_in, model, thinking_level)
    SELECT job_title_id, name, built_in, enabled, job_description, skills, permissions,
    mcp_servers, bypass_opt_in, model, thinking_level FROM job_titles_before ORDER BY rowid`)
  yield* sql.unsafe('DROP TABLE job_titles_before')
  const [clash] = yield* sql<{
    readonly job_title_id: string
    readonly name: string
  }>`SELECT job_title_id, name FROM job_titles WHERE name = ${EXECUTIVE_ASSISTANT.name} COLLATE NOCASE`
  if (clash !== undefined) {
    const taken = yield* sql<{ readonly name: string }>`SELECT name FROM job_titles`
    const name = freeName(clash.name, new Set(taken.map((row) => row.name.toLowerCase())))
    yield* sql`UPDATE job_titles SET name = ${name} WHERE job_title_id = ${clash.job_title_id}`
  }
  yield* sql`INSERT INTO job_titles ${sql.insert({
    job_title_id: EXECUTIVE_ASSISTANT.id,
    name: EXECUTIVE_ASSISTANT.name,
    built_in: EXECUTIVE_ASSISTANT.kind,
    enabled: 1,
    job_description: EXECUTIVE_ASSISTANT.jobDescription,
    skills: '[]',
    permissions: encodePermissions({ allow: [...EXECUTIVE_ASSISTANT.allow], ask: [], deny: [] }),
    mcp_servers: '{}',
    bypass_opt_in: 0
  })}`
  yield* sql.unsafe(`CREATE TABLE assistant_session (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    pane_id    TEXT    NOT NULL,
    session_id TEXT
  )`)
  yield* sql.unsafe('CREATE TABLE assistant_objectives (objective_id TEXT PRIMARY KEY)')
  yield* Effect.logInfo('Added the Executive assistant job title and its session tables', {
    renamedCopy: clash?.job_title_id ?? null
  })
})

const SAVED_REFERENCES = [
  { table: 'issues', key: 'issue_id', column: 'assignee' },
  { table: 'objectives', key: 'objective_id', column: 'assignee' },
  { table: 'issue_comments', key: 'comment_id', column: 'author' }
] as const

const savedTable = (table: string) => `saved_${table}_hires`

const moveToAgentDefinitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe('PRAGMA defer_foreign_keys = ON')
  for (const { table, key, column } of SAVED_REFERENCES) {
    yield* sql.unsafe(`CREATE TEMP TABLE ${savedTable(table)} AS
      SELECT ${key} AS saved_key, ${column} AS saved_hire FROM ${table} WHERE ${column} IS NOT NULL`)
  }
  yield* sql.unsafe(`CREATE TABLE hired_agents_next (
    hire_id         TEXT    PRIMARY KEY,
    job_title_id    TEXT    NOT NULL,
    name            TEXT    UNIQUE COLLATE NOCASE,
    bypass_override INTEGER CHECK (bypass_override IN (0, 1)),
    hired_at        INTEGER NOT NULL,
    reports_to      TEXT    REFERENCES hired_agents_next(hire_id)
  )`)
  yield* sql.unsafe(`INSERT INTO hired_agents_next (hire_id, job_title_id, name, bypass_override, hired_at, reports_to)
    SELECT hire_id, job_title_id, name, bypass_override, hired_at, reports_to FROM hired_agents ORDER BY rowid`)
  yield* sql.unsafe('DROP TABLE hired_agents')
  yield* sql.unsafe('ALTER TABLE hired_agents_next RENAME TO hired_agents')
  for (const { table, key, column } of SAVED_REFERENCES) {
    yield* sql.unsafe(`UPDATE ${table} SET ${column} = saved.saved_hire
      FROM ${savedTable(table)} AS saved WHERE ${table}.${key} = saved.saved_key`)
    yield* sql.unsafe(`DROP TABLE ${savedTable(table)}`)
  }
  yield* sql.unsafe(`CREATE TABLE job_title_settings (
    job_title_id TEXT    PRIMARY KEY,
    enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1))
  )`)
  yield* sql.unsafe(`INSERT INTO job_title_settings (job_title_id, enabled)
    SELECT job_title_id, 0 FROM job_titles WHERE enabled = 0`)
  yield* sql.unsafe('ALTER TABLE job_titles RENAME TO job_titles_handover')
  yield* sql.unsafe(
    "ALTER TABLE issues ADD COLUMN missing TEXT NOT NULL DEFAULT '[]' CHECK (status = 'triage' OR missing = '[]')"
  )
  const [counts] = yield* sql<{
    readonly hires: number
    readonly disabled: number
    readonly handover: number
  }>`SELECT (SELECT count(*) FROM hired_agents) AS hires,
    (SELECT count(*) FROM job_title_settings) AS disabled,
    (SELECT count(*) FROM job_titles_handover) AS handover`
  yield* Effect.logInfo('Prepared the org to hand its job titles to agent-definitions', {
    hires: counts?.hires ?? 0,
    disabledJobTitles: counts?.disabled ?? 0,
    jobTitlesToHandOver: counts?.handover ?? 0
  })
})

const moveToIssuesPlugin = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const table of ['objectives', 'issues', 'issue_comments', 'org_events']) {
    yield* sql.unsafe(`ALTER TABLE ${table} RENAME TO ${table}_handover`)
  }
  yield* Effect.logInfo('Prepared the org to hand its objectives and issues to issues')
})

const createWorktreeTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe('CREATE TABLE project_worktrees (project_id TEXT PRIMARY KEY)')
  yield* sql.unsafe(`CREATE TABLE issue_worktrees (
    issue_id    TEXT    PRIMARY KEY,
    path        TEXT    NOT NULL,
    branch      TEXT    NOT NULL,
    source_repo TEXT    NOT NULL,
    released    INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1))
  )`)
  yield* Effect.logInfo('Created the project and issue worktree tables')
})

const createRunTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE issue_runs (
    issue_id TEXT PRIMARY KEY,
    hire_id  TEXT NOT NULL,
    run_id   TEXT NOT NULL
  )`)
  yield* sql.unsafe(`CREATE TABLE assistant_run (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT NOT NULL
  )`)
  yield* Effect.logInfo('Created the issue run and assistant run tables')
})

/**
 * The `org` plugin's migrations, passed to `ctx.database`. `1_create_org_tables` creates the
 * first roles, hired agents and org settings tables; `2_seed_org` inserts the default overall cap;
 * `3_job_titles` replaces the roles table with the job titles table, inserts the built-in job
 * titles, keeps the user's copies and their hires, and drops the five old built-in roles and their
 * hires; `4_add_reports_to` adds each hired agent's `reportsTo`, null for existing hires;
 * `5_job_title_model` adds each job title's model, null, and thinking level, `medium`;
 * `6_objectives_tasks` creates the objectives and tasks tables and the event table that records
 * their changes; `7_issues` replaces the tasks table with the issues table (`waiting` and
 * `running` tasks become `todo`, the rest `done`), adds the issue comments table, and adds the
 * three org issue tools to each built-in job title's allowed tools; `8_executive_assistant` widens
 * the built-in kinds to include `executive-assistant`, inserts that job title (renaming a copy that
 * has its name), and creates the assistant's session and objectives tables;
 * `9_agent_definitions` drops the hired agents' reference to the job titles table (keeping every
 * issue and objective assignee, comment author and reporting line), moves each disabled job
 * title's flag to `job_title_settings`, renames the job titles table to `job_titles_handover` for
 * `org`'s host to hand over to `agent-definitions` and `mcp`, and adds each issue's `missing`
 * names, which must be `[]` unless the issue is in `triage`; `10_issues_handover` renames the
 * objectives, issues, issue comments and org events tables to `*_handover` for `org`'s host to
 * hand over to `issues`; `11_worktrees` creates `project_worktrees` (a row means issues of that
 * project run in worktrees) and `issue_worktrees` (the worktree each issue last ran in, and whether
 * it was released); `12_runs` creates `issue_runs` (the run of each issue and the hire it ran for)
 * and `assistant_run` (the Executive assistant's run). Each runs once per database.
 */
export const orgMigrations: PluginMigrations = {
  '1_create_org_tables': createTables,
  '2_seed_org': seedOrgSettings,
  '3_job_titles': moveToJobTitles,
  '4_add_reports_to': addReportsTo,
  '5_job_title_model': addJobTitleModel,
  '6_objectives_tasks': createObjectivesAndTasks,
  '7_issues': moveToIssues,
  '8_executive_assistant': addExecutiveAssistant,
  '9_agent_definitions': moveToAgentDefinitions,
  '10_issues_handover': moveToIssuesPlugin,
  '11_worktrees': createWorktreeTables,
  '12_runs': createRunTables
}
