import type { RegisteredDefinition } from '@dia-plugin/agent-definitions/registry'
import { openIssues, orgRef, PROJECT } from '@dia-plugin/issues/issues.fake'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem, Layer, Path, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { handOverJobTitles, handOverWork, handoverPending, workHandoverPending } from './handover'
import { orgMigrations } from './migrations'
import { builtInDefinitionRegistry, mcpRegistry } from './registries.fake'

const { '10_issues_handover': _handover, ...migrationsBeforeHandover } = orgMigrations
const { '9_agent_definitions': _definitions, ...migrationsBeforeDefinitions } =
  migrationsBeforeHandover

const COPY_ID = '00000000-0000-4000-8000-000000000901'
const GITHUB_STDIO = { type: 'stdio', command: 'gh-mcp', args: [], env: {} } as const
const GITHUB_HTTP = { type: 'http', url: 'https://github.example/mcp', headers: {} } as const
const NO_RULES = '{"allow":[],"ask":[],"deny":[]}'

const builtInId = (sql: SqlClient.SqlClient, kind: string) =>
  sql<{
    readonly job_title_id: string
  }>`SELECT job_title_id FROM job_titles WHERE built_in = ${kind}`.pipe(
    Effect.map(([row]) => row?.job_title_id ?? '')
  )

const handedOverOrg = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'org.db')
  const scope = yield* Scope.make()
  const old = yield* openDatabase(filename, migrationsBeforeDefinitions).pipe(Scope.provide(scope))
  const editedId = yield* builtInId(old, 'software-engineer')
  const uneditedId = yield* builtInId(old, 'quality-engineer')
  yield* old`UPDATE job_titles SET job_description = 'Writes Rust only.',
    mcp_servers = ${JSON.stringify({ github: GITHUB_STDIO })} WHERE job_title_id = ${editedId}`
  yield* old`INSERT INTO job_titles ${old.insert({
    job_title_id: COPY_ID,
    name: 'Release manager',
    built_in: null,
    enabled: 1,
    job_description: 'Cuts releases.',
    skills: '["release"]',
    permissions: NO_RULES,
    mcp_servers: JSON.stringify({ github: GITHUB_HTTP }),
    bypass_opt_in: 1,
    model: 'claude-sonnet-5',
    thinking_level: 'high'
  })}`
  yield* Scope.close(scope, Exit.void)
  const sql = yield* openDatabase(filename, orgMigrations)
  const definitions = yield* builtInDefinitionRegistry()
  const { registry: mcp } = yield* mcpRegistry()
  const handOver = handOverJobTitles(definitions, mcp).pipe(
    Effect.provideService(SqlClient.SqlClient, sql)
  )
  yield* sql`CREATE TABLE job_titles_backup AS SELECT * FROM job_titles_handover`
  yield* handOver
  return { sql, definitions, mcp, handOver, editedId, uneditedId }
}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

const byId = (list: ReadonlyArray<RegisteredDefinition>, id: string) =>
  list.find((entry) => entry.definition.id === id)

describe('handOverJobTitles after 9_agent_definitions', () => {
  it.effect('imports a copy as a user definition with its fields and its server name', () =>
    Effect.gen(function* () {
      const { definitions } = yield* handedOverOrg
      const copy = byId(yield* definitions.list, COPY_ID)
      assert.deepStrictEqual(copy, {
        definition: {
          id: COPY_ID,
          name: 'Release manager',
          jobDescription: 'Cuts releases.',
          skills: ['release'],
          permissions: { allow: [], ask: [], deny: [] },
          mcpServers: ['github-2'],
          bypassOptIn: true,
          model: 'claude-sonnet-5',
          thinkingLevel: 'high'
        },
        source: { _tag: 'User' },
        edited: false
      } as never)
    }).pipe(Effect.scoped)
  )

  it.effect('imports two servers sharing a name with different configs under two names', () =>
    Effect.gen(function* () {
      const { mcp } = yield* handedOverOrg
      assert.deepStrictEqual(
        (yield* mcp.list).map((server) => [server.name, server.server.type]),
        [
          ['github', 'stdio'],
          ['github-2', 'http']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('overrides only the built-in whose fields were edited', () =>
    Effect.gen(function* () {
      const { definitions, editedId, uneditedId } = yield* handedOverOrg
      const list = yield* definitions.list
      assert.deepStrictEqual(
        [
          list.filter((entry) => entry.edited).map((entry) => entry.definition.id),
          byId(list, editedId)?.definition.jobDescription,
          byId(list, editedId)?.definition.mcpServers,
          byId(list, uneditedId)?.edited
        ],
        [[editedId], 'Writes Rust only.', ['github'], false]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('drops the handover table once done', () =>
    Effect.gen(function* () {
      const { sql } = yield* handedOverOrg
      assert.isFalse(yield* handoverPending.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
    }).pipe(Effect.scoped)
  )

  it.effect(
    'changes nothing when run again over the same rows after a failure before the drop',
    () =>
      Effect.gen(function* () {
        const { sql, definitions, mcp, handOver } = yield* handedOverOrg
        const before = [yield* definitions.list, yield* mcp.list]
        yield* sql`ALTER TABLE job_titles_backup RENAME TO job_titles_handover`

        yield* handOver

        assert.deepStrictEqual([yield* definitions.list, yield* mcp.list], before)
      }).pipe(Effect.scoped)
  )
})

const HIRE_ID = '00000000-0000-4000-8000-000000000a01'
const WORK_OBJECTIVE_ID = '00000000-0000-4000-8000-000000000a02'
const TRIAGED_ID = '00000000-0000-4000-8000-000000000a03'
const ASSIGNED_ID = '00000000-0000-4000-8000-000000000a04'
const WORK_COMMENT_ID = '00000000-0000-4000-8000-000000000a05'

const workIssue = (
  issueId: string,
  n: number,
  status: string,
  assignee: string | null,
  missing: string
) => ({
  issue_id: issueId,
  objective_id: WORK_OBJECTIVE_ID,
  parent_issue_id: null,
  kind: 'work',
  title: `Issue ${n}`,
  description: '',
  status,
  assignee,
  pane_id: `00000000-0000-4000-8000-000000000b0${n}`,
  session_id: null,
  created_at: n,
  missing
})

const orgWithWork = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'org.db')
  const scope = yield* Scope.make()
  const old = yield* openDatabase(filename, migrationsBeforeHandover).pipe(Scope.provide(scope))
  yield* old`INSERT INTO hired_agents ${old.insert({
    hire_id: HIRE_ID,
    job_title_id: yield* builtInIdAfterDefinitions(old),
    name: 'ada',
    bypass_override: null,
    hired_at: 0,
    reports_to: null
  })}`
  yield* old`INSERT INTO objectives ${old.insert({
    objective_id: WORK_OBJECTIVE_ID,
    project_id: PROJECT,
    title: 'Ship',
    description: '',
    priority: 'high',
    assignee: HIRE_ID,
    state: 'open',
    created_at: 0
  })}`
  yield* old`INSERT INTO issues ${old.insert(workIssue(TRIAGED_ID, 1, 'triage', null, '[{"kind":"skill","name":"plan"}]'))}`
  yield* old`INSERT INTO issues ${old.insert(workIssue(ASSIGNED_ID, 2, 'todo', HIRE_ID, '[]'))}`
  yield* old`INSERT INTO issue_comments ${old.insert({
    comment_id: WORK_COMMENT_ID,
    issue_id: ASSIGNED_ID,
    author: HIRE_ID,
    body: 'On it.',
    created_at: 3
  })}`
  yield* Scope.close(scope, Exit.void)
  const sql = yield* openDatabase(filename, orgMigrations)
  const { issues } = yield* openIssues
  const handOver = handOverWork(issues).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  return { sql, issues, handOver }
}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

const builtInIdAfterDefinitions = (sql: SqlClient.SqlClient) =>
  sql<{ readonly job_title_id: string }>`SELECT job_title_id FROM job_titles_handover LIMIT 1`.pipe(
    Effect.map(([row]) => row?.job_title_id ?? '')
  )

describe('handOverWork after 10_issues_handover', () => {
  it.effect(
    "imports every hire reference as an org assignee and a triaged issue's missing names as its refusal",
    () =>
      Effect.gen(function* () {
        const { issues, handOver } = yield* orgWithWork

        yield* handOver

        const snapshot = yield* issues.snapshot
        assert.deepStrictEqual(
          {
            objective: snapshot.objectives.map((objective) => [objective.id, objective.assignee]),
            issues: snapshot.issues.map((issue) => [
              issue.id,
              issue.status,
              issue.assignee,
              issue.refusal
            ]),
            comments: snapshot.comments.map((comment) => [comment.id, comment.author])
          },
          {
            objective: [[WORK_OBJECTIVE_ID, orgRef(HIRE_ID)]],
            issues: [
              [TRIAGED_ID, 'triage', null, 'Cannot start: missing plan (skill)'],
              [ASSIGNED_ID, 'todo', orgRef(HIRE_ID), null]
            ],
            comments: [[WORK_COMMENT_ID, orgRef(HIRE_ID)]]
          }
        )
      }).pipe(Effect.scoped)
  )

  it.effect('drops the four handover tables once done', () =>
    Effect.gen(function* () {
      const { sql, handOver } = yield* orgWithWork

      yield* handOver

      assert.isFalse(
        yield* workHandoverPending.pipe(Effect.provideService(SqlClient.SqlClient, sql))
      )
    }).pipe(Effect.scoped)
  )

  it.effect('imports nothing twice when run again before the drop', () =>
    Effect.gen(function* () {
      const { sql, issues, handOver } = yield* orgWithWork
      yield* sql`CREATE TABLE issues_keep AS SELECT * FROM issues_handover`
      yield* handOver
      const once = yield* issues.snapshot
      yield* sql`CREATE TABLE issues_handover AS SELECT * FROM issues_keep`
      yield* sql`CREATE TABLE objectives_handover (objective_id TEXT)`
      yield* sql`CREATE TABLE issue_comments_handover (comment_id TEXT)`
      yield* sql`CREATE TABLE org_events_handover (seq INTEGER)`

      yield* handOver

      assert.deepStrictEqual(yield* issues.snapshot, once)
    }).pipe(Effect.scoped)
  )
})
