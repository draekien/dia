import type { PluginMigrations } from '@dia/plugin'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem, Layer, Path, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeWork } from './work'

const OLD_BUILT_INS = ['planner', 'engineer', 'reviewer', 'researcher', 'retro'] as const
const oldRoleId = (index: number) => `6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a000${index + 1}`
const OLD_ENGINEER_ID = oldRoleId(1)
const OLD_RETRO_ID = oldRoleId(4)
const STRICT_ENGINEER_ID = '00000000-0000-4000-8000-000000000101'
const TEAM_LEAD_COPY_ID = '00000000-0000-4000-8000-000000000102'
const TEAM_LEAD_OLD_COPY_ID = '00000000-0000-4000-8000-000000000103'
const BRAVE_OTTER_ID = '00000000-0000-4000-8000-000000000201'
const NO_RULES = '{"allow":[],"ask":[],"deny":[]}'

const role = (roleId: string, name: string, builtIn: string | null) => ({
  role_id: roleId,
  name,
  built_in: builtIn,
  enabled: 1,
  instructions: `${name} instructions`,
  skills: '[]',
  permissions: NO_RULES,
  mcp_servers: '{}',
  bypass_opt_in: 0
})

const hire = (hireId: string, roleId: string, name: string | null) => ({
  hire_id: hireId,
  role_id: roleId,
  name,
  bypass_override: null,
  hired_at: 0
})

const oldSeed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const [index, kind] of OLD_BUILT_INS.entries()) {
    yield* sql`INSERT INTO roles ${sql.insert(role(oldRoleId(index), kind, kind))}`
  }
  yield* sql`INSERT INTO hired_agents ${sql.insert(hire('6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a1001', OLD_RETRO_ID, null))}`
  yield* sql`INSERT INTO org_settings ${sql.insert({ singleton: 1, overall_cap: 4 })}`
})

const legacyMigrations = {
  '1_create_org_tables': orgMigrations['1_create_org_tables'],
  '2_seed_org': oldSeed
}

const openIn = (filename: string, migrations: PluginMigrations) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const sql = yield* openDatabase(filename, migrations).pipe(Scope.provide(scope))
    return { sql, close: Scope.close(scope, Exit.void) }
  })

const upgradedLegacyOrg = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'data.db')
  const legacy = yield* openIn(filename, legacyMigrations)
  yield* legacy.sql`INSERT INTO roles ${legacy.sql.insert(role(STRICT_ENGINEER_ID, 'Strict engineer', null))}`
  yield* legacy.sql`INSERT INTO roles ${legacy.sql.insert(role(TEAM_LEAD_COPY_ID, 'team LEAD', null))}`
  yield* legacy.sql`INSERT INTO roles ${legacy.sql.insert(role(TEAM_LEAD_OLD_COPY_ID, 'Team lead (old)', null))}`
  yield* legacy.sql`INSERT INTO hired_agents ${legacy.sql.insert(hire(BRAVE_OTTER_ID, STRICT_ENGINEER_ID, 'brave-otter'))}`
  yield* legacy.sql`INSERT INTO hired_agents ${legacy.sql.insert(hire('00000000-0000-4000-8000-000000000202', OLD_ENGINEER_ID, 'calm-heron'))}`
  yield* legacy.close
  const sql = yield* openDatabase(filename, orgMigrations)
  const org = yield* makeWork(() => Effect.succeed(true)).pipe(
    Effect.flatMap(({ openIssuesOf }) => makeOrg(openIssuesOf)),
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provide(NodeCrypto.layer)
  )
  return { org, sql }
}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

describe('3_job_titles on a database seeded with the old built-in roles', () => {
  it.effect('keeps the seven built-ins and the copies, renaming copies that clash', () =>
    Effect.gen(function* () {
      const { org } = yield* upgradedLegacyOrg
      assert.deepStrictEqual(
        (yield* org.jobTitles).map((jobTitle): [string, string | null] => [
          jobTitle.name,
          jobTitle.builtIn
        ]),
        [
          ['Product manager', 'product-manager'],
          ['Software engineer', 'software-engineer'],
          ['Quality engineer', 'quality-engineer'],
          ['Business analyst', 'business-analyst'],
          ['UI/UX designer', 'ui-ux'],
          ['Team lead', 'team-lead'],
          ['Technical lead', 'technical-lead'],
          ['Strict engineer', null],
          ['team LEAD (old 2)', null],
          ['Team lead (old)', null]
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("keeps each copy's id and moves its instructions into its job description", () =>
    Effect.gen(function* () {
      const { org } = yield* upgradedLegacyOrg
      const copies = (yield* org.jobTitles).filter((jobTitle) => jobTitle.builtIn === null)
      assert.deepStrictEqual(
        copies.map((copy): [string, string] => [copy.id, copy.jobDescription]),
        [
          [STRICT_ENGINEER_ID, 'Strict engineer instructions'],
          [TEAM_LEAD_COPY_ID, 'team LEAD instructions'],
          [TEAM_LEAD_OLD_COPY_ID, 'Team lead (old) instructions']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('keeps only the hires of copies', () =>
    Effect.gen(function* () {
      const { org } = yield* upgradedLegacyOrg
      assert.deepStrictEqual(
        (yield* org.hiredAgents).map((hired): [string, string, string | null] => [
          hired.id,
          hired.jobTitleId,
          hired.name
        ]),
        [[BRAVE_OTTER_ID, STRICT_ENGINEER_ID, 'brave-otter']]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('leaves hired agents referencing job titles', () =>
    Effect.gen(function* () {
      const { sql } = yield* upgradedLegacyOrg
      const violations = yield* sql`PRAGMA foreign_key_check`
      const insert = yield* Effect.exit(
        sql`INSERT INTO hired_agents ${sql.insert({
          hire_id: '00000000-0000-4000-8000-000000000203',
          job_title_id: OLD_ENGINEER_ID,
          name: null,
          bypass_override: null,
          hired_at: 0
        })}`
      )
      assert.deepStrictEqual([violations.length, Exit.isFailure(insert)], [0, true])
    }).pipe(Effect.scoped)
  )
})

describe('4_add_reports_to on a database with hires', () => {
  it.effect('makes every existing hired agent report to the user', () =>
    Effect.gen(function* () {
      const { org } = yield* upgradedLegacyOrg
      assert.deepStrictEqual(
        (yield* org.hiredAgents).map((hired) => hired.reportsTo),
        [null]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses deleting a manager whose reports still point at it', () =>
    Effect.gen(function* () {
      const { sql } = yield* upgradedLegacyOrg
      yield* sql`INSERT INTO hired_agents ${sql.insert({
        hire_id: '00000000-0000-4000-8000-000000000204',
        job_title_id: STRICT_ENGINEER_ID,
        name: null,
        bypass_override: null,
        reports_to: BRAVE_OTTER_ID,
        hired_at: 1
      })}`
      const removed = yield* Effect.exit(
        sql`DELETE FROM hired_agents WHERE hire_id = ${BRAVE_OTTER_ID}`
      )
      assert.isTrue(Exit.isFailure(removed))
    }).pipe(Effect.scoped)
  )
})

describe('5_job_title_model on a database with job titles', () => {
  it.effect('gives every existing job title no model and the medium thinking level', () =>
    Effect.gen(function* () {
      const { org } = yield* upgradedLegacyOrg
      const settings = new Set(
        (yield* org.jobTitles).map((jobTitle) => `${jobTitle.model}/${jobTitle.thinkingLevel}`)
      )
      assert.deepStrictEqual([...settings], ['null/medium'])
    }).pipe(Effect.scoped)
  )
})

const { '7_issues': _issues, ...migrationsBeforeIssues } = orgMigrations
const OBJECTIVE_ID = '00000000-0000-4000-8000-000000000301'
const COPY_ID = '00000000-0000-4000-8000-000000000302'
const taskRowId = (n: number) => `00000000-0000-4000-8000-00000000040${n}`

const task = (
  n: number,
  state: string,
  options: { parent?: number; kind?: string; session?: string } = {}
) => ({
  task_id: taskRowId(n),
  objective_id: OBJECTIVE_ID,
  parent_task_id: options.parent === undefined ? null : taskRowId(options.parent),
  kind: options.kind ?? 'work',
  title: `Task ${n}`,
  state,
  assignee: null,
  pane_id: `00000000-0000-4000-8000-00000000050${n}`,
  session_id: options.session ?? null,
  created_at: n
})

const upgradedTasks = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'data.db')
  const before = yield* openIn(filename, migrationsBeforeIssues)
  const old = before.sql
  yield* old`INSERT INTO objectives ${old.insert({
    objective_id: OBJECTIVE_ID,
    project_id: '00000000-0000-4000-8000-000000000300',
    title: 'Ship',
    description: '',
    priority: 'normal',
    assignee: null,
    state: 'open',
    created_at: 0
  })}`
  yield* old`INSERT INTO job_titles ${old.insert({
    job_title_id: COPY_ID,
    name: 'My copy',
    built_in: null,
    enabled: 1,
    job_description: '',
    skills: '[]',
    permissions: NO_RULES,
    mcp_servers: '{}',
    bypass_opt_in: 0
  })}`
  for (const row of [
    task(1, 'waiting'),
    task(2, 'running', { parent: 1, session: 'session-2' }),
    task(3, 'finished'),
    task(4, 'completed', { parent: 3, kind: 'retro' })
  ]) {
    yield* old`INSERT INTO tasks ${old.insert(row)}`
  }
  yield* before.close
  const sql = yield* openDatabase(filename, orgMigrations)
  return { sql }
}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

describe('7_issues on a database with tasks', () => {
  it.effect('maps waiting and running tasks to todo and finished and completed ones to done', () =>
    Effect.gen(function* () {
      const { sql } = yield* upgradedTasks
      const rows = yield* sql<{
        readonly issue_id: string
        readonly status: string
      }>`SELECT issue_id, status FROM issues ORDER BY created_at`
      assert.deepStrictEqual(
        rows.map((row) => [row.issue_id, row.status]),
        [
          [taskRowId(1), 'todo'],
          [taskRowId(2), 'todo'],
          [taskRowId(3), 'done'],
          [taskRowId(4), 'done']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("keeps a running task's session, parent and kind, with an empty description", () =>
    Effect.gen(function* () {
      const { sql } = yield* upgradedTasks
      const [row] = yield* sql<{
        readonly session_id: string | null
        readonly parent_issue_id: string | null
        readonly description: string
      }>`SELECT session_id, parent_issue_id, description FROM issues WHERE issue_id = ${taskRowId(2)}`
      const [retro] = yield* sql<{
        readonly kind: string
      }>`SELECT kind FROM issues WHERE issue_id = ${taskRowId(4)}`
      assert.deepStrictEqual(
        [row?.session_id, row?.parent_issue_id, row?.description, retro?.kind],
        ['session-2', taskRowId(1), '', 'retro']
      )
    }).pipe(Effect.scoped)
  )

  it.effect(
    'leaves sub-issues and retros referencing their parents, and drops the tasks table',
    () =>
      Effect.gen(function* () {
        const { sql } = yield* upgradedTasks
        const violations = yield* sql`PRAGMA foreign_key_check`
        const tasks = yield* sql`SELECT name FROM sqlite_master WHERE name = 'tasks'`
        assert.deepStrictEqual([violations.length, tasks.length], [0, 0])
      }).pipe(Effect.scoped)
  )

  it.effect('takes a comment on a migrated issue and refuses one on a missing issue', () =>
    Effect.gen(function* () {
      const { sql } = yield* upgradedTasks
      const comment = (issueId: string, commentId: string) =>
        Effect.exit(
          sql`INSERT INTO issue_comments ${sql.insert({
            comment_id: commentId,
            issue_id: issueId,
            author: null,
            body: 'Looks good.',
            created_at: 1
          })}`
        )
      const stored = yield* comment(taskRowId(1), '00000000-0000-4000-8000-000000000601')
      const orphan = yield* comment(
        '00000000-0000-4000-8000-000000000699',
        '00000000-0000-4000-8000-000000000602'
      )
      assert.deepStrictEqual([Exit.isSuccess(stored), Exit.isFailure(orphan)], [true, true])
    }).pipe(Effect.scoped)
  )

  it.effect('allows the three issue tools on every built-in job title and not on a copy', () =>
    Effect.gen(function* () {
      const { sql } = yield* upgradedTasks
      const rows = yield* sql<{
        readonly built_in: string | null
        readonly permissions: string
      }>`SELECT built_in, permissions FROM job_titles`
      const allowed = rows.map((row): [boolean, ReadonlyArray<string>] => [
        row.built_in !== null,
        (JSON.parse(row.permissions) as { allow: ReadonlyArray<string> }).allow
      ])
      const issueTools = [
        'mcp__dia__create_issue',
        'mcp__dia__update_issue',
        'mcp__dia__comment_issue'
      ]
      assert.deepStrictEqual(
        allowed.filter(([builtIn]) => builtIn).map(([, allow]) => allow),
        Array.from({ length: 7 }, () => issueTools)
      )
      assert.deepStrictEqual(
        allowed.filter(([builtIn]) => !builtIn).map(([, allow]) => allow),
        [[]]
      )
    }).pipe(Effect.scoped)
  )
})
