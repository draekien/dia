import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from 'effect'
import type { SqlClient } from 'effect/sql'
import {
  AssigneeNotFound,
  AssigneeProviderTaken,
  FirstIssue,
  Issue,
  IssueId,
  IssueNotAssignable,
  IssueNotFound,
  IssueNotInTriage,
  IssueNotStarted,
  Objective,
  ObjectiveId,
  ObjectiveNotFound,
  ProjectNotFound,
  ProviderId,
  Refusal,
  WorkTitle
} from './domain'
import { ORG, openIssues, orgRef, PROJECT, registerFixed, UNREGISTERED } from './issues.fake'
import type { Issues, ProviderIssues } from './service'

const objectiveId = (n: number) => ObjectiveId.make(`00000000-0000-4000-8000-5000000000${n}0`)
const issueId = (n: number) => IssueId.make(`00000000-0000-4000-8000-6000000000${n}0`)

const ADA = orgRef('ada')
const BEN = orgRef('ben')

const newObjective = (n: number) => ({
  id: objectiveId(n),
  projectId: PROJECT,
  title: WorkTitle.make('Ship the marketplace'),
  description: 'Let users install plugins.',
  priority: 'normal' as const,
  assignee: null
})

const planning = FirstIssue.make({
  kind: 'planning',
  title: WorkTitle.make('Plan: Ship the marketplace'),
  description: '',
  assignee: null
})

const openWithOrg = Effect.gen(function* () {
  const env = yield* openIssues
  const runs = yield* registerFixed(env.issues, ['ada', 'ben'])
  return { ...env, runs }
})

type Env = {
  readonly issues: Issues
  readonly sql: SqlClient.SqlClient
  readonly runs: ProviderIssues
}

const withObjective = Effect.gen(function* () {
  const env = yield* openWithOrg
  const objective = yield* env.issues.createObjective(newObjective(1), [])
  return { ...env, objective }
})

const createWorkIssue = (
  env: Env,
  n: number,
  objective: ObjectiveId,
  assignee: Issue['assignee'] = null
) =>
  env.issues.createIssue({
    id: issueId(n),
    objectiveId: objective,
    parentIssueId: null,
    title: WorkTitle.make(`Issue ${n}`),
    description: '',
    assignee
  })

const withStartedIssue = Effect.gen(function* () {
  const env = yield* withObjective
  const issue = yield* createWorkIssue(env, 1, env.objective.id, ADA)
  assert.isTrue(yield* env.runs.markStarted(issue.id, 'ada'))
  return { ...env, issue }
})

const issueOf = (env: Env, id: IssueId) =>
  Effect.map(env.issues.snapshot, (snapshot) => snapshot.issues.find((issue) => issue.id === id))

const statusOf = (env: Env, id: IssueId) => Effect.map(issueOf(env, id), (issue) => issue?.status)

const objectiveState = (env: Env, id: ObjectiveId) =>
  Effect.map(
    env.issues.snapshot,
    (snapshot) => snapshot.objectives.find((objective) => objective.id === id)?.state
  )

const countRows = (
  sql: SqlClient.SqlClient,
  table: 'issues' | 'issue_events' | 'objectives' | 'issue_comments'
) =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`,
    ([row]) => row?.n ?? 0
  )

const runTool = (
  env: Env,
  fromIssue: IssueId,
  assigneeId: string,
  name: string,
  input: Record<string, string>
) => {
  const tool = env.runs.issueTools(fromIssue, assigneeId).find((entry) => entry.name === name)
  assert.isDefined(tool, name)
  return tool.run(input)
}

describe('Issues.createObjective', () => {
  it.effect('refuses a project the workspace does not list', () =>
    Effect.gen(function* () {
      const { issues } = yield* openWithOrg
      const error = yield* issues
        .createObjective({ ...newObjective(1), projectId: UNREGISTERED }, [])
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, ProjectNotFound.make({ projectId: UNREGISTERED }))
    }).pipe(Effect.scoped)
  )

  it.effect('creates an open objective with no issues when given none', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const snapshot = yield* env.issues.snapshot
      assert.deepStrictEqual(
        [snapshot.objectives.map((objective) => objective.state), snapshot.issues],
        [['open'], []]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('creates each first issue in todo in the objective, with its kind and assignee', () =>
    Effect.gen(function* () {
      const env = yield* openWithOrg
      yield* env.issues.createObjective(newObjective(1), [
        planning,
        FirstIssue.make({
          kind: 'work',
          title: WorkTitle.make('Build it'),
          description: 'All of it.',
          assignee: ADA
        })
      ])
      const { issues } = yield* env.issues.snapshot
      assert.deepStrictEqual(
        issues.map((issue) => [
          issue.objectiveId,
          issue.kind,
          issue.title,
          issue.status,
          issue.assignee,
          issue.parentIssueId
        ]),
        [
          [objectiveId(1), 'planning', 'Plan: Ship the marketplace', 'todo', null, null],
          [objectiveId(1), 'work', 'Build it', 'todo', ADA, null]
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an assignee no held provider lists, and creates nothing', () =>
    Effect.gen(function* () {
      const env = yield* openWithOrg
      const stranger = orgRef('stranger')
      const error = yield* env.issues
        .createObjective({ ...newObjective(1), assignee: stranger }, [])
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [error, yield* countRows(env.sql, 'objectives')],
        [AssigneeNotFound.make({ assignee: stranger }), 0]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('returns the stored objective and writes nothing when the id is repeated', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const again = yield* env.issues.createObjective(
        { ...newObjective(1), title: WorkTitle.make('Another title') },
        [planning]
      )
      assert.deepStrictEqual(again, env.objective)
      assert.deepStrictEqual(
        [yield* countRows(env.sql, 'objectives'), yield* countRows(env.sql, 'issues')],
        [1, 0]
      )
    }).pipe(Effect.scoped)
  )
})

describe('Issues.stopObjective', () => {
  it.effect('cancels every open issue, leaves a done one, and completes the objective', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.issues.finishIssue(env.issue.id)
      const open = yield* createWorkIssue(env, 2, env.objective.id)
      const canceled = yield* env.issues.stopObjective(env.objective.id)
      const snapshot = yield* env.issues.snapshot
      assert.deepStrictEqual(
        [
          canceled.map((issue) => [issue.id, issue.status]),
          snapshot.issues.map((issue) => [issue.id, issue.status]),
          snapshot.objectives.map((objective) => objective.state)
        ],
        [
          [[open.id, 'canceled']],
          [
            [env.issue.id, 'done'],
            [open.id, 'canceled']
          ],
          ['completed']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an unknown objective', () =>
    Effect.gen(function* () {
      const env = yield* openWithOrg
      const error = yield* env.issues.stopObjective(objectiveId(9)).pipe(Effect.flip)
      assert.deepStrictEqual(error, ObjectiveNotFound.make({ objectiveId: objectiveId(9) }))
    }).pipe(Effect.scoped)
  )
})

describe('Issues.createIssue', () => {
  it.effect('creates a work issue in todo with its assignee', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const created = yield* createWorkIssue(env, 1, env.objective.id, BEN)
      assert.deepStrictEqual(
        [created.kind, created.status, created.assignee, created.refusal],
        ['work', 'todo', BEN, null]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a missing objective', () =>
    Effect.gen(function* () {
      const env = yield* openWithOrg
      const error = yield* createWorkIssue(env, 1, objectiveId(9)).pipe(Effect.flip)
      assert.deepStrictEqual(error, ObjectiveNotFound.make({ objectiveId: objectiveId(9) }))
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a parent issue of another objective', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* env.issues.createObjective(newObjective(2), [])
      yield* createWorkIssue(env, 1, objectiveId(2))
      const error = yield* env.issues
        .createIssue({
          id: issueId(2),
          objectiveId: env.objective.id,
          parentIssueId: issueId(1),
          title: WorkTitle.make('Child'),
          description: '',
          assignee: null
        })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotFound.make({ issueId: issueId(1) }))
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an assignee of a provider that is not held', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const elsewhere = { provider: ProviderId.make('tracker'), id: 'ada' }
      const error = yield* createWorkIssue(env, 1, env.objective.id, elsewhere).pipe(Effect.flip)
      assert.deepStrictEqual(error, AssigneeNotFound.make({ assignee: elsewhere }))
    }).pipe(Effect.scoped)
  )

  it.effect('leaves no issue row when its event cannot be written', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* env.sql.unsafe(
        "CREATE TRIGGER refuse_events BEFORE INSERT ON issue_events BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
      const exit = yield* createWorkIssue(env, 1, env.objective.id).pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
      assert.strictEqual(yield* countRows(env.sql, 'issues'), 0)
    }).pipe(Effect.scoped)
  )

  it.effect('reopens a completed objective', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.issues.finishIssue(env.issue.id)
      const before = yield* objectiveState(env, env.objective.id)
      yield* createWorkIssue(env, 5, env.objective.id)
      assert.deepStrictEqual(
        [before, yield* objectiveState(env, env.objective.id)],
        ['completed', 'open']
      )
    }).pipe(Effect.scoped)
  )
})

describe('Issues.assignIssue', () => {
  it.effect('assigns a todo issue, and unassigns it with null', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id)
      const assigned = yield* env.issues.assignIssue(issue.id, BEN)
      const unassigned = yield* env.issues.assignIssue(issue.id, null)
      assert.deepStrictEqual([assigned.assignee, unassigned.assignee], [BEN, null])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses to give a started issue to another assignee', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const error = yield* env.issues.assignIssue(env.issue.id, BEN).pipe(Effect.flip)
      assert.deepStrictEqual(
        error,
        IssueNotAssignable.make({ issueId: env.issue.id, status: 'understanding' })
      )
    }).pipe(Effect.scoped)
  )

  it.effect('returns a started issue unchanged when given its current assignee again', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const again = yield* env.issues.assignIssue(env.issue.id, ADA)
      assert.deepStrictEqual([again.status, again.assignee], ['understanding', ADA])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an assignee its provider does not list', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id)
      const stranger = orgRef('stranger')
      const error = yield* env.issues.assignIssue(issue.id, stranger).pipe(Effect.flip)
      assert.deepStrictEqual(error, AssigneeNotFound.make({ assignee: stranger }))
    }).pipe(Effect.scoped)
  )
})

const withTriage = Effect.gen(function* () {
  const env = yield* withStartedIssue
  const propose = (title: string) => runTool(env, env.issue.id, 'ada', 'create_issue', { title })
  yield* propose('First')
  yield* propose('Second')
  const triage = (yield* env.issues.snapshot).issues.filter((issue) => issue.status === 'triage')
  const [first, second] = triage
  assert.isDefined(first)
  assert.isDefined(second)
  return { ...env, first, second }
})

describe('Issues.triageIssues', () => {
  it.effect('moves every triage issue to todo on accept', () =>
    Effect.gen(function* () {
      const env = yield* withTriage
      const triaged = yield* env.issues.triageIssues([env.first.id, env.second.id], 'accept')
      assert.deepStrictEqual(
        triaged.map((issue) => issue.status),
        ['todo', 'todo']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('moves every triage issue to canceled on decline', () =>
    Effect.gen(function* () {
      const env = yield* withTriage
      yield* env.issues.triageIssues([env.first.id, env.second.id], 'decline')
      assert.deepStrictEqual(
        [yield* statusOf(env, env.first.id), yield* statusOf(env, env.second.id)],
        ['canceled', 'canceled']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('fails the whole call and changes nothing when one issue is not in triage', () =>
    Effect.gen(function* () {
      const env = yield* withTriage
      yield* env.issues.triageIssues([env.second.id], 'decline')
      const error = yield* env.issues
        .triageIssues([env.first.id, env.second.id], 'accept')
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        error,
        IssueNotInTriage.make({ issueId: env.second.id, status: 'canceled' })
      )
      assert.strictEqual(yield* statusOf(env, env.first.id), 'triage')
    }).pipe(Effect.scoped)
  )

  it.effect('clears the refusal of an accepted issue', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id, ADA)
      yield* env.runs.markRefused(
        issue.id,
        Refusal.make('Cannot start: missing github (MCP server)')
      )
      yield* env.issues.triageIssues([issue.id], 'accept')
      const stored = yield* issueOf(env, issue.id)
      assert.deepStrictEqual([stored?.status, stored?.refusal], ['todo', null])
    }).pipe(Effect.scoped)
  )
})

describe('Issues.finishIssue', () => {
  it.effect('refuses an issue that has not started', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id)
      const error = yield* env.issues.finishIssue(issue.id).pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotStarted.make({ issueId: issue.id, status: 'todo' }))
    }).pipe(Effect.scoped)
  )

  it.effect('moves a work issue to done and creates no retro, also when repeated', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const first = yield* env.issues.finishIssue(env.issue.id)
      const second = yield* env.issues.finishIssue(env.issue.id)
      const { issues } = yield* env.issues.snapshot
      assert.deepStrictEqual(
        [first.status, second, issues.map((issue) => issue.kind)],
        ['done', first, ['work']]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('completes the objective once its last open issue is finished', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const before = yield* objectiveState(env, env.objective.id)
      yield* env.issues.finishIssue(env.issue.id)
      assert.deepStrictEqual(
        [before, yield* objectiveState(env, env.objective.id)],
        ['open', 'completed']
      )
    }).pipe(Effect.scoped)
  )
})

describe('Issues.registerProvider', () => {
  it.effect('returns only after the first assignees emission, which then validates', () =>
    Effect.gen(function* () {
      const { issues } = yield* openIssues
      const gate = yield* Deferred.make<void>()
      const registering = yield* issues
        .registerProvider({
          id: ORG,
          label: 'Org',
          assignees: Stream.fromEffect(
            Effect.as(Deferred.await(gate), [{ id: 'ada', name: 'Ada', detail: '' }])
          )
        })
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const before = registering.pollUnsafe()
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(registering)
      assert.deepStrictEqual(
        [before, yield* issues.providers],
        [
          undefined,
          [{ provider: ORG, label: 'Org', assignees: [{ id: 'ada', name: 'Ada', detail: '' }] }]
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a second provider with the same id', () =>
    Effect.gen(function* () {
      const { issues } = yield* openIssues
      yield* registerFixed(issues, ['ada'])
      const error = yield* registerFixed(issues, ['ben']).pipe(Effect.flip)
      assert.deepStrictEqual(error, AssigneeProviderTaken.make({ provider: ORG }))
    }).pipe(Effect.scoped)
  )

  it.effect('on release, requeues its started issues but in_review, keeping their assignees', () =>
    Effect.gen(function* () {
      const env = yield* openIssues
      const scope = yield* Scope.make()
      const runs = yield* registerFixed(env.issues, ['ada', 'ben']).pipe(Scope.provide(scope))
      yield* env.issues.createObjective(newObjective(1), [])
      const working = yield* createWorkIssue({ ...env, runs }, 1, objectiveId(1), ADA)
      const reviewing = yield* createWorkIssue({ ...env, runs }, 2, objectiveId(1), BEN)
      yield* runs.markStarted(working.id, 'ada')
      yield* runs.markStarted(reviewing.id, 'ben')
      yield* runTool({ ...env, runs }, reviewing.id, 'ben', 'update_issue', { status: 'in_review' })
      yield* Scope.close(scope, Exit.void)
      const { issues } = yield* env.issues.snapshot
      assert.deepStrictEqual(
        [issues.map((issue) => [issue.status, issue.assignee]), yield* env.issues.providers],
        [
          [
            ['todo', ADA],
            ['in_review', BEN]
          ],
          []
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("lets a provider run only its own assignees' issues", () =>
    Effect.gen(function* () {
      const env = yield* openWithOrg
      const tracker = yield* registerFixed(env.issues, ['ada'], ProviderId.make('tracker'))
      yield* env.issues.createObjective(newObjective(1), [])
      const theirs = yield* createWorkIssue(env, 1, objectiveId(1), {
        provider: ProviderId.make('tracker'),
        id: 'ada'
      })
      const ours = yield* createWorkIssue(env, 2, objectiveId(1), ADA)
      const startable = (yield* env.runs.runState).startable.map(({ issue }) => issue.id)
      assert.deepStrictEqual(
        [
          startable,
          yield* env.runs.markStarted(theirs.id, 'ada'),
          yield* tracker.markStarted(ours.id, 'ada')
        ],
        [[ours.id], false, false]
      )
    }).pipe(Effect.scoped)
  )
})

describe('ProviderIssues', () => {
  it.effect('starts a todo issue only for the assignee it is assigned to', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id, ADA)
      assert.isFalse(yield* env.runs.markStarted(issue.id, 'ben'))
      assert.isTrue(yield* env.runs.markStarted(issue.id, 'ada'))
      assert.strictEqual(yield* statusOf(env, issue.id), 'understanding')
    }).pipe(Effect.scoped)
  )

  it.effect('moves a refused issue to triage with its refusal', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id, ADA)
      const refusal = Refusal.make('Cannot start: missing github (MCP server)')
      assert.isTrue(yield* env.runs.markRefused(issue.id, refusal))
      const stored = yield* issueOf(env, issue.id)
      assert.deepStrictEqual([stored?.status, stored?.refusal], ['triage', refusal])
    }).pipe(Effect.scoped)
  )

  it.effect('requeues an implementing issue to todo and leaves an in_review issue as it is', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const other = yield* createWorkIssue(env, 2, env.objective.id, BEN)
      yield* env.runs.markStarted(other.id, 'ben')
      yield* runTool(env, env.issue.id, 'ada', 'update_issue', { status: 'implementing' })
      yield* runTool(env, other.id, 'ben', 'update_issue', { status: 'in_review' })
      assert.strictEqual(yield* env.runs.requeueRunning, 1)
      assert.deepStrictEqual(
        [yield* statusOf(env, env.issue.id), yield* statusOf(env, other.id)],
        ['todo', 'in_review']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('counts the open issues of an assignee, not its closed ones', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* createWorkIssue(env, 2, env.objective.id, ADA)
      const before = yield* env.runs.countOpenIssues('ada')
      yield* env.issues.finishIssue(env.issue.id)
      assert.deepStrictEqual([before, yield* env.runs.countOpenIssues('ada')], [2, 1])
    }).pipe(Effect.scoped)
  )
})

describe('Issues.importWork', () => {
  const imported = (objective: Objective, issue: Issue) => ({
    objectives: [objective],
    issues: [issue],
    comments: [],
    events: [{ seq: 7, at: 1, objectiveId: objective.id, issueId: issue.id, event: '{}' }]
  })

  it.effect('adds the rows once, so a second run adds nothing', () =>
    Effect.gen(function* () {
      const env = yield* openIssues
      const objective = Objective.make({
        ...newObjective(1),
        assignee: ADA,
        state: 'open',
        createdAt: 1
      })
      const issue = Issue.make({
        id: issueId(1),
        objectiveId: objective.id,
        parentIssueId: null,
        kind: 'work',
        title: WorkTitle.make('Imported'),
        description: '',
        status: 'triage',
        assignee: ADA,
        paneId: '00000000-0000-4000-8000-700000000001',
        sessionId: null,
        refusal: Refusal.make('Cannot start: missing github (MCP server)'),
        createdAt: 2
      })
      yield* env.issues.importWork(imported(objective, issue))
      yield* env.issues.importWork(imported(objective, issue))
      const snapshot = yield* env.issues.snapshot
      assert.deepStrictEqual(
        [snapshot.objectives, snapshot.issues, yield* countRows(env.sql, 'issue_events')],
        [[objective], [issue], 1]
      )
    }).pipe(Effect.scoped)
  )
})
