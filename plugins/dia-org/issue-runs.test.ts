import { RESUME_TEXT } from '@dia/plugin'
import { FirstIssue, type Issue, ObjectiveId, WorkTitle } from '@dia-plugin/dia-issues/domain'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { AgentName } from '@shared/domain/project'
import { Deferred, Effect, Exit, Option, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { openIssues, orgRef, PROJECT } from '../dia-issues/issues.fake'
import { orgAssignees } from './assignees'
import { ORG_PROVIDER } from './domain'
import { ISSUE_RUN_LABEL, runIssues } from './issue-runs'
import { IssueDirectory, IssueWaiting } from './issue-workspace'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { holdBuiltInDefinitions } from './registries.fake'
import { issueStartOptions } from './run-options'
import { fakeBackend, fakeRuns, model } from './runs.fake'

const OBJECTIVE = ObjectiveId.make('00000000-0000-4000-8000-600000000001')
const TITLE = WorkTitle.make('Add a login page')
const PROJECT_DIRECTORY = 'C:/dia'

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 100; turn += 1) yield* Effect.yieldNow
})

const setUp = Effect.gen(function* () {
  const dbScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(dbScope, Exit.void))
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(dbScope))
  const org = yield* makeOrg.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provide(NodeCrypto.layer)
  )
  yield* holdBuiltInDefinitions(org)
  const { issues } = yield* openIssues
  const provider = yield* issues.registerProvider({
    id: ORG_PROVIDER,
    label: 'Org',
    assignees: orgAssignees(org)
  })
  const engineer = (yield* org.jobTitles).find((title) => title.builtIn === 'software-engineer')
  assert.isDefined(engineer)
  const ada = yield* org.hire(engineer.id, AgentName.make('Ada'), null)
  const grace = yield* org.hire(engineer.id, AgentName.make('Grace'), null)
  const fake = fakeRuns()
  const ready = yield* Deferred.make<void>()
  const issueRuns = yield* runIssues({
    org,
    issues,
    provider,
    workspace: { retain: () => Effect.void },
    startOptions: (issue) =>
      Effect.succeed(
        Option.some({
          run: {
            cwd: `C:/trees/${issue.id}`,
            model: 'opus',
            thinkingLevel: 'medium' as const,
            permissionMode: 'default' as const,
            text: issue.title
          },
          projectDirectory: PROJECT_DIRECTORY
        })
      ),
    runs: fake.runs,
    queue: fake.queue,
    ready: Deferred.await(ready)
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  const createIssue = (assigneeId: string) =>
    Effect.gen(function* () {
      yield* settle
      yield* issues.createObjective(
        {
          id: OBJECTIVE,
          projectId: PROJECT,
          title: TITLE,
          description: '',
          priority: 'high',
          assignee: null
        },
        [
          FirstIssue.make({
            kind: 'work',
            title: TITLE,
            description: '',
            assignee: orgRef(assigneeId)
          })
        ]
      )
      const issue = (yield* issues.snapshot).issues[0]
      assert.isDefined(issue)
      return issue
    })
  const statusOf = (issue: Issue) =>
    Effect.map(
      issues.snapshot,
      (snapshot) => snapshot.issues.find((i) => i.id === issue.id)?.status
    )
  const storeRun = (issue: Issue, hireId: string, runId: string) =>
    sql`INSERT INTO issue_runs (issue_id, hire_id, run_id) VALUES (${issue.id}, ${hireId}, ${runId})`.pipe(
      Effect.orDie
    )
  const begin = Deferred.succeed(ready, undefined).pipe(Effect.andThen(settle))
  return { issues, ada, grace, fake, issueRuns, createIssue, statusOf, storeRun, begin }
})

describe('runIssues', () => {
  it.effect(
    'queues a todo issue of a hire under the hire key with the issue as the run context',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp
        const issue = yield* env.createIssue(env.ada.id)
        yield* env.begin

        assert.strictEqual(env.fake.enqueued.length, 1)
        const [queued] = env.fake.enqueued
        assert.isDefined(queued)
        assert.deepStrictEqual(queued.entry.key, { id: env.ada.id, limit: 1 })
        assert.deepStrictEqual(queued.entry.run.context, {
          issueId: issue.id,
          assigneeId: env.ada.id
        })
        assert.deepStrictEqual(queued.entry.run.labels, [ISSUE_RUN_LABEL])
        assert.strictEqual(queued.entry.run.cwd, `C:/trees/${issue.id}`)
        assert.strictEqual(
          queued.entry.priority,
          1,
          'a high-priority objective ranks above normal (0)'
        )
        assert.strictEqual(yield* env.statusOf(issue), 'todo', 'a queued issue has not started')
      }).pipe(Effect.scoped)
  )

  it.effect('moves the issue to understanding once the queue starts its run', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      yield* env.begin
      const [queued] = env.fake.enqueued
      assert.isDefined(queued)

      yield* queued.start('run-a')
      yield* env.begin

      assert.strictEqual(yield* env.statusOf(issue), 'understanding')
      assert.strictEqual(env.fake.enqueued.length, 1, 'a started issue is not queued again')
      assert.isTrue(yield* env.issueRuns.deliver(issue.id, 'hello'))
      assert.deepStrictEqual(env.fake.sent, [{ runId: 'run-a', text: 'hello' }])
    }).pipe(Effect.scoped)
  )

  it.effect("shows a started issue's run in a tab of its project without selecting it", () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.createIssue(env.ada.id)
      yield* env.begin
      const [queued] = env.fake.enqueued
      assert.isDefined(queued)

      yield* queued.start('run-a')
      yield* env.begin

      assert.deepStrictEqual(env.fake.tabs, [
        { runId: 'run-a', placement: { projectDirectory: PROJECT_DIRECTORY, select: false } }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('does not show a run whose issue was canceled while it was queued', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.createIssue(env.ada.id)
      yield* env.begin
      const [queued] = env.fake.enqueued
      assert.isDefined(queued)
      yield* env.issues.stopObjective(OBJECTIVE)
      yield* env.begin

      yield* queued.start('run-a')
      yield* env.begin

      assert.deepStrictEqual(env.fake.tabs, [])
    }).pipe(Effect.scoped)
  )

  it.effect('closes a run started for an issue that was canceled while it was queued', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      yield* env.begin
      const [queued] = env.fake.enqueued
      assert.isDefined(queued)
      yield* env.issues.stopObjective(OBJECTIVE)
      yield* env.begin

      yield* queued.start('run-a')
      yield* env.begin

      assert.deepStrictEqual(env.fake.closed, ['run-a'])
      assert.strictEqual(yield* env.statusOf(issue), 'canceled')
    }).pipe(Effect.scoped)
  )

  it.effect('closes the run of a started issue once the issue is canceled', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.createIssue(env.ada.id)
      yield* env.begin
      const [queued] = env.fake.enqueued
      assert.isDefined(queued)
      yield* queued.start('run-a')
      yield* env.begin

      yield* env.issues.stopObjective(OBJECTIVE)
      yield* env.begin

      assert.deepStrictEqual(env.fake.closed, ['run-a'])
    }).pipe(Effect.scoped)
  )

  it.effect('marks a todo issue started without a new run while its stored run is mid-turn', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      yield* env.storeRun(issue, env.ada.id, 'run-old')
      env.fake.setRun('run-old', 'running', false)

      yield* env.begin

      assert.strictEqual(env.fake.enqueued.length, 0)
      assert.deepStrictEqual(env.fake.sent, [], 'recovery resumes the turn, not org')
      assert.strictEqual(yield* env.statusOf(issue), 'understanding')
    }).pipe(Effect.scoped)
  )

  it.effect('resumes an idle stored run of the same hire instead of starting a new one', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      yield* env.storeRun(issue, env.ada.id, 'run-old')
      env.fake.setRun('run-old', 'idle', false)

      yield* env.begin

      assert.strictEqual(env.fake.enqueued.length, 0)
      assert.deepStrictEqual(env.fake.sent, [{ runId: 'run-old', text: RESUME_TEXT }])
      assert.strictEqual(yield* env.statusOf(issue), 'understanding')
    }).pipe(Effect.scoped)
  )

  it.effect('resumes a stored run whose session is open but idle', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      yield* env.storeRun(issue, env.ada.id, 'run-old')
      env.fake.setRun('run-old', 'idle', true)

      yield* env.begin

      assert.strictEqual(env.fake.enqueued.length, 0)
      assert.deepStrictEqual(env.fake.sent, [{ runId: 'run-old', text: RESUME_TEXT }])
    }).pipe(Effect.scoped)
  )

  it.effect('queues a new run when the stored run is archived', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      yield* env.storeRun(issue, env.ada.id, 'run-old')
      env.fake.setRun('run-old', 'archived', false)

      yield* env.begin

      assert.strictEqual(env.fake.enqueued.length, 1)
      assert.deepStrictEqual(env.fake.sent, [])
    }).pipe(Effect.scoped)
  )

  it.effect("queues a new run for another hire's issue and closes the earlier hire's run", () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.grace.id)
      yield* env.storeRun(issue, env.ada.id, 'run-old')
      env.fake.setRun('run-old', 'idle', true)

      yield* env.begin

      assert.deepStrictEqual(env.fake.closed, ['run-old'])
      assert.deepStrictEqual(env.fake.enqueued[0]?.entry.key, { id: env.grace.id, limit: 1 })
    }).pipe(Effect.scoped)
  )

  it.effect('reports no live run to deliver to for an issue that never ran', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      yield* env.begin

      assert.isFalse(yield* env.issueRuns.deliver(issue.id, 'hello'))
      assert.deepStrictEqual(env.fake.sent, [])
    }).pipe(Effect.scoped)
  )
})

describe('issueStartOptions', () => {
  const ISSUE_PATH = 'C:/dia/plugins/dia-worktrees/trees/add-login'

  it.effect("starts the run in the issue's worktree with its job description first", () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      const objective = (yield* env.issues.snapshot).objectives[0]
      assert.isDefined(objective)
      const workspace = {
        open: () =>
          Effect.succeed(
            IssueDirectory.make({ path: ISSUE_PATH, projectDirectory: PROJECT_DIRECTORY })
          )
      }
      const jobTitle = {
        ...(yield* setUpJobTitle),
        model: null,
        jobDescription: 'You write code.'
      }

      const options = yield* issueStartOptions(workspace, fakeBackend([model('opus', true)]))(
        issue,
        objective,
        env.ada,
        jobTitle
      )

      assert.isTrue(Option.isSome(options))
      if (Option.isNone(options)) return
      assert.strictEqual(options.value.run.cwd, ISSUE_PATH)
      assert.strictEqual(options.value.projectDirectory, PROJECT_DIRECTORY)
      assert.strictEqual(options.value.run.model, 'opus', 'no job title model: the catalog first')
      assert.strictEqual(options.value.run.permissionMode, 'auto', 'the model supports auto')
      assert.isTrue(options.value.run.text.startsWith('You write code.\n\n'))
    }).pipe(Effect.scoped)
  )

  it.effect('returns none while the issue waits for its workspace', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const issue = yield* env.createIssue(env.ada.id)
      const objective = (yield* env.issues.snapshot).objectives[0]
      assert.isDefined(objective)
      const workspace = {
        open: () => Effect.succeed(IssueWaiting.make({ reason: 'The project is not registered' }))
      }

      const options = yield* issueStartOptions(workspace, fakeBackend([model('opus')]))(
        issue,
        objective,
        env.ada,
        yield* setUpJobTitle
      )

      assert.isTrue(Option.isNone(options))
    }).pipe(Effect.scoped)
  )
})

const setUpJobTitle = Effect.gen(function* () {
  const dbScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(dbScope, Exit.void))
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(dbScope))
  const org = yield* makeOrg.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provide(NodeCrypto.layer)
  )
  yield* holdBuiltInDefinitions(org)
  const engineer = (yield* org.jobTitles).find((title) => title.builtIn === 'software-engineer')
  assert.isDefined(engineer)
  return engineer
})
