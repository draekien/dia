import { ProjectId } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import {
  CommentBody,
  HireHasOpenIssues,
  type Issue,
  IssueClosed,
  IssueId,
  IssueNotAssignable,
  IssueNotFound,
  IssueNotInTriage,
  IssueNotStarted,
  ObjectiveId,
  ObjectiveNotFound,
  ProjectNotFound,
  WorkTitle
} from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeWork } from './work'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-400000000001')
const UNREGISTERED = ProjectId.make('00000000-0000-4000-8000-400000000002')
const objectiveId = (n: number) => ObjectiveId.make(`00000000-0000-4000-8000-5000000000${n}0`)
const issueId = (n: number) => IssueId.make(`00000000-0000-4000-8000-6000000000${n}0`)

const present = <A>(value: A | undefined, what: string): A => {
  assert.isDefined(value, what)
  return value as A
}

const openWork = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(scope))
  const built = yield* Effect.gen(function* () {
    const made = yield* makeWork((projectId) => Effect.succeed(projectId === PROJECT))
    const org = yield* makeOrg(made.openIssuesOf)
    return { ...made, org }
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(NodeCrypto.layer))
  const engineer = present((yield* built.org.jobTitles)[0], 'a built-in job title')
  const ada = yield* built.org.hire(engineer.id, null, null)
  const ben = yield* built.org.hire(engineer.id, null, null)
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  return { ...built, sql, ada: ada.id, ben: ben.id }
})

type Env = Effect.Success<typeof openWork>

const newObjective = (n: number, assignee: Env['ada'] | null = null) => ({
  id: objectiveId(n),
  projectId: PROJECT,
  title: WorkTitle.make('Ship the marketplace'),
  description: 'Let users install plugins.',
  priority: 'normal' as const,
  assignee
})

const withObjective = Effect.gen(function* () {
  const env = yield* openWork
  const objective = yield* env.work.createObjective(newObjective(1))
  const planning = present(
    (yield* env.work.snapshot).issues.find((issue) => issue.kind === 'planning'),
    'the planning issue'
  )
  return { ...env, objective, planning }
})

const createWorkIssue = (
  env: Env,
  n: number,
  objective: ObjectiveId,
  assignee: Env['ada'] | null = null
) =>
  env.work.createIssue({
    id: issueId(n),
    objectiveId: objective,
    parentIssueId: null,
    title: WorkTitle.make(`Issue ${n}`),
    description: '',
    assignee
  })

const withStartedIssue = Effect.gen(function* () {
  const env = yield* withObjective
  const issue = yield* createWorkIssue(env, 1, env.objective.id, env.ada)
  assert.isTrue(yield* env.runs.markStarted(issue.id, env.ada))
  return { ...env, issue }
})

const statusOf = (env: Env, id: IssueId) =>
  Effect.map(
    env.work.snapshot,
    (snapshot) => snapshot.issues.find((issue) => issue.id === id)?.status
  )

const objectiveState = (env: Env, id: ObjectiveId) =>
  Effect.map(
    env.work.snapshot,
    (snapshot) => snapshot.objectives.find((objective) => objective.id === id)?.state
  )

const countRows = (
  sql: SqlClient.SqlClient,
  table: 'issues' | 'org_events' | 'objectives' | 'issue_comments'
) =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`,
    ([row]) => row?.n ?? 0
  )

const finishPlanning = (env: Env & { readonly planning: Issue }) =>
  Effect.gen(function* () {
    yield* env.work.assignIssue(env.planning.id, env.ben)
    yield* env.runs.markStarted(env.planning.id, env.ben)
    yield* env.work.finishIssue(env.planning.id)
  })

describe('Work.createObjective', () => {
  it.effect('refuses a project the workspace does not list', () =>
    Effect.gen(function* () {
      const { work } = yield* openWork
      const error = yield* work
        .createObjective({ ...newObjective(1), projectId: UNREGISTERED })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, ProjectNotFound.make({ projectId: UNREGISTERED }))
    }).pipe(Effect.scoped)
  )

  it.effect('creates an unassigned planning issue in todo when the objective has no assignee', () =>
    Effect.gen(function* () {
      const { planning, objective } = yield* withObjective
      assert.deepStrictEqual(
        [
          planning.objectiveId,
          planning.title,
          planning.description,
          planning.status,
          planning.assignee
        ],
        [objective.id, 'Plan: Ship the marketplace', '', 'todo', null]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("gives the planning issue to the objective's assignee, so it can start", () =>
    Effect.gen(function* () {
      const env = yield* openWork
      yield* env.work.createObjective(newObjective(1, env.ada))
      const { startable } = yield* env.runs.startCandidates
      assert.deepStrictEqual(
        startable.map(({ issue }) => [issue.kind, issue.assignee]),
        [['planning', env.ada]]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('truncates a long planning title to the title limit', () =>
    Effect.gen(function* () {
      const env = yield* openWork
      yield* env.work.createObjective({
        ...newObjective(1),
        title: WorkTitle.make('x'.repeat(120))
      })
      const [planning] = (yield* env.work.snapshot).issues
      assert.strictEqual(planning?.title, `Plan: ${'x'.repeat(114)}`)
    }).pipe(Effect.scoped)
  )

  it.effect('returns the stored objective and writes nothing when the id is repeated', () =>
    Effect.gen(function* () {
      const { work, sql, objective } = yield* withObjective
      const again = yield* work.createObjective({
        ...newObjective(1),
        title: WorkTitle.make('Another title')
      })
      assert.deepStrictEqual(again, objective)
      assert.deepStrictEqual(
        [yield* countRows(sql, 'objectives'), yield* countRows(sql, 'issues')],
        [1, 1]
      )
    }).pipe(Effect.scoped)
  )
})

describe('Work.createIssue', () => {
  it.effect('refuses a missing objective', () =>
    Effect.gen(function* () {
      const env = yield* openWork
      const error = yield* createWorkIssue(env, 1, objectiveId(9)).pipe(Effect.flip)
      assert.deepStrictEqual(error, ObjectiveNotFound.make({ objectiveId: objectiveId(9) }))
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a parent issue of another objective', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* env.work.createObjective(newObjective(2))
      yield* createWorkIssue(env, 1, objectiveId(2))
      const error = yield* env.work
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

  it.effect('leaves no issue row when its event cannot be written', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* env.sql.unsafe(
        "CREATE TRIGGER refuse_events BEFORE INSERT ON org_events BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
      const exit = yield* createWorkIssue(env, 1, env.objective.id).pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
      assert.strictEqual(yield* countRows(env.sql, 'issues'), 1)
    }).pipe(Effect.scoped)
  )

  it.effect('reopens a completed objective', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* finishPlanning(env)
      const before = yield* objectiveState(env, env.objective.id)
      yield* createWorkIssue(env, 5, env.objective.id)
      assert.deepStrictEqual(
        [before, yield* objectiveState(env, env.objective.id)],
        ['completed', 'open']
      )
    }).pipe(Effect.scoped)
  )
})

describe('Work.proposeIssue', () => {
  it.effect('adds an unassigned work issue in triage', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const proposed = yield* env.work.proposeIssue(env.objective.id, {
        parentIssueId: env.planning.id,
        title: WorkTitle.make('Fetch the index'),
        description: 'Read the plugin index.'
      })
      assert.deepStrictEqual(
        [proposed.kind, proposed.status, proposed.assignee, proposed.parentIssueId],
        ['work', 'triage', null, env.planning.id]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a parent issue of another objective', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* env.work.createObjective(newObjective(2))
      const other = yield* createWorkIssue(env, 1, objectiveId(2))
      const error = yield* env.work
        .proposeIssue(env.objective.id, {
          parentIssueId: other.id,
          title: WorkTitle.make('Child'),
          description: ''
        })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotFound.make({ issueId: other.id }))
    }).pipe(Effect.scoped)
  )
})

describe('Work.assignIssue', () => {
  it.effect('assigns a triage issue', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const proposed = yield* env.work.proposeIssue(env.objective.id, {
        parentIssueId: null,
        title: WorkTitle.make('Proposed'),
        description: ''
      })
      const assigned = yield* env.work.assignIssue(proposed.id, env.ben)
      assert.strictEqual(assigned.assignee, env.ben)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses to give a started issue to another hired agent', () =>
    Effect.gen(function* () {
      const { work, issue, ben } = yield* withStartedIssue
      const error = yield* work.assignIssue(issue.id, ben).pipe(Effect.flip)
      assert.deepStrictEqual(
        error,
        IssueNotAssignable.make({ issueId: issue.id, status: 'understanding' })
      )
    }).pipe(Effect.scoped)
  )

  it.effect('returns a started issue unchanged when given its current assignee again', () =>
    Effect.gen(function* () {
      const { work, issue, ada } = yield* withStartedIssue
      const again = yield* work.assignIssue(issue.id, ada)
      assert.deepStrictEqual([again.status, again.assignee], ['understanding', ada])
    }).pipe(Effect.scoped)
  )
})

const withTriage = Effect.gen(function* () {
  const env = yield* withObjective
  const propose = (title: string) =>
    env.work.proposeIssue(env.objective.id, {
      parentIssueId: null,
      title: WorkTitle.make(title),
      description: ''
    })
  const first = yield* propose('First')
  const second = yield* propose('Second')
  return { ...env, first, second }
})

describe('Work.triageIssues', () => {
  it.effect('moves every triage issue to todo on accept', () =>
    Effect.gen(function* () {
      const env = yield* withTriage
      const triaged = yield* env.work.triageIssues([env.first.id, env.second.id], 'accept')
      assert.deepStrictEqual(
        triaged.map((issue) => issue.status),
        ['todo', 'todo']
      )
      assert.strictEqual(yield* statusOf(env, env.second.id), 'todo')
    }).pipe(Effect.scoped)
  )

  it.effect('moves every triage issue to canceled on decline', () =>
    Effect.gen(function* () {
      const env = yield* withTriage
      yield* env.work.triageIssues([env.first.id, env.second.id], 'decline')
      assert.deepStrictEqual(
        [yield* statusOf(env, env.first.id), yield* statusOf(env, env.second.id)],
        ['canceled', 'canceled']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('leaves an issue already at the target unchanged', () =>
    Effect.gen(function* () {
      const env = yield* withTriage
      yield* env.work.triageIssues([env.first.id], 'accept')
      const triaged = yield* env.work.triageIssues([env.first.id, env.second.id], 'accept')
      assert.deepStrictEqual(
        triaged.map((issue) => issue.status),
        ['todo', 'todo']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('fails the whole call and changes nothing when one issue is not in triage', () =>
    Effect.gen(function* () {
      const env = yield* withTriage
      yield* env.work.triageIssues([env.second.id], 'decline')
      const error = yield* env.work
        .triageIssues([env.first.id, env.second.id], 'accept')
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        error,
        IssueNotInTriage.make({ issueId: env.second.id, status: 'canceled' })
      )
      assert.strictEqual(yield* statusOf(env, env.first.id), 'triage')
    }).pipe(Effect.scoped)
  )

  it.effect('completes the objective when declining its last open issue', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const proposed = yield* env.work.proposeIssue(env.objective.id, {
        parentIssueId: null,
        title: WorkTitle.make('Only one'),
        description: ''
      })
      yield* finishPlanning(env)
      const before = yield* objectiveState(env, env.objective.id)
      yield* env.work.triageIssues([proposed.id], 'decline')
      assert.deepStrictEqual(
        [before, yield* objectiveState(env, env.objective.id)],
        ['open', 'completed']
      )
    }).pipe(Effect.scoped)
  )
})

describe('Work.updateIssue', () => {
  it.effect('sets a started issue to another started status', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const updated = yield* env.work.updateIssue(env.objective.id, env.issue.id, {
        status: 'in_review'
      })
      assert.deepStrictEqual(
        [updated.status, yield* statusOf(env, env.issue.id)],
        ['in_review', 'in_review']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('changes the title and description of an issue that is not closed', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id)
      yield* env.work.updateIssue(env.objective.id, issue.id, {
        title: WorkTitle.make('Renamed'),
        description: 'More detail.'
      })
      const stored = (yield* env.work.snapshot).issues.find((entry) => entry.id === issue.id)
      assert.deepStrictEqual([stored?.title, stored?.description], ['Renamed', 'More detail.'])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a status on an issue that has not started', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id)
      const error = yield* env.work
        .updateIssue(env.objective.id, issue.id, { status: 'testing' })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotStarted.make({ issueId: issue.id, status: 'todo' }))
    }).pipe(Effect.scoped)
  )

  it.effect('reports IssueNotStarted before IssueClosed and writes nothing', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.work.finishIssue(env.issue.id)
      const error = yield* env.work
        .updateIssue(env.objective.id, env.issue.id, {
          title: WorkTitle.make('Renamed'),
          status: 'testing'
        })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotStarted.make({ issueId: env.issue.id, status: 'done' }))
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a title on a closed issue', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.work.finishIssue(env.issue.id)
      const error = yield* env.work
        .updateIssue(env.objective.id, env.issue.id, { title: WorkTitle.make('Renamed') })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueClosed.make({ issueId: env.issue.id, status: 'done' }))
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an issue of another objective as not found', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.work.createObjective(newObjective(2))
      const error = yield* env.work
        .updateIssue(objectiveId(2), env.issue.id, { status: 'testing' })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotFound.make({ issueId: env.issue.id }))
    }).pipe(Effect.scoped)
  )

  it.effect('returns the issue unchanged and writes no event for an empty change', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const events = yield* countRows(env.sql, 'org_events')
      const same = yield* env.work.updateIssue(env.objective.id, env.issue.id, {})
      assert.strictEqual(same.status, 'understanding')
      assert.strictEqual(yield* countRows(env.sql, 'org_events'), events)
    }).pipe(Effect.scoped)
  )
})

describe('Work.commentIssue', () => {
  it.effect('stores a comment the snapshot lists', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const comment = yield* env.work.commentIssue(
        env.objective.id,
        env.planning.id,
        env.ada,
        CommentBody.make('Planned three issues.')
      )
      assert.deepStrictEqual((yield* env.work.snapshot).comments, [comment])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an issue of another objective and stores nothing', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* env.work.createObjective(newObjective(2))
      const error = yield* env.work
        .commentIssue(objectiveId(2), env.planning.id, env.ada, CommentBody.make('Hi'))
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotFound.make({ issueId: env.planning.id }))
      assert.strictEqual(yield* countRows(env.sql, 'issue_comments'), 0)
    }).pipe(Effect.scoped)
  )
})

describe('Work.finishIssue', () => {
  it.effect('refuses an issue that has not started', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id)
      const error = yield* env.work.finishIssue(issue.id).pipe(Effect.flip)
      assert.deepStrictEqual(error, IssueNotStarted.make({ issueId: issue.id, status: 'todo' }))
    }).pipe(Effect.scoped)
  )

  it.effect(
    'moves a work issue to done with one unassigned retro in todo, also when repeated',
    () =>
      Effect.gen(function* () {
        const { work, issue } = yield* withStartedIssue
        const first = yield* work.finishIssue(issue.id)
        const second = yield* work.finishIssue(issue.id)
        const retros = (yield* work.snapshot).issues.filter((entry) => entry.kind === 'retro')
        assert.strictEqual(first.status, 'done')
        assert.deepStrictEqual(second, first)
        assert.deepStrictEqual(
          retros.map((retro) => [retro.parentIssueId, retro.assignee, retro.status, retro.title]),
          [[issue.id, null, 'todo', 'Retro: Issue 1']]
        )
      }).pipe(Effect.scoped)
  )

  it.effect('gives a planning issue no retro', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* finishPlanning(env)
      const kinds = (yield* env.work.snapshot).issues.map((issue) => issue.kind)
      assert.deepStrictEqual(kinds, ['planning'])
    }).pipe(Effect.scoped)
  )

  it.effect('completes the objective once its last open issue is finished', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      yield* env.work.assignIssue(env.planning.id, env.ben)
      yield* env.runs.markStarted(env.planning.id, env.ben)
      const before = yield* objectiveState(env, env.objective.id)
      yield* env.work.finishIssue(env.planning.id)
      assert.deepStrictEqual(
        [before, yield* objectiveState(env, env.objective.id)],
        ['open', 'completed']
      )
    }).pipe(Effect.scoped)
  )
})

describe('Org.dismiss with issues', () => {
  it.effect('refuses a hired agent assigned to an in_review issue', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.work.updateIssue(env.objective.id, env.issue.id, { status: 'in_review' })
      const error = yield* env.org.dismiss(env.ada).pipe(Effect.flip)
      assert.deepStrictEqual(error, HireHasOpenIssues.make({ hireId: env.ada, issues: 1 }))
    }).pipe(Effect.scoped)
  )
})

describe('IssueRuns', () => {
  it.effect('starts a todo issue only for the hired agent it is assigned to', () =>
    Effect.gen(function* () {
      const env = yield* withObjective
      const issue = yield* createWorkIssue(env, 1, env.objective.id, env.ada)
      assert.isFalse(yield* env.runs.markStarted(issue.id, env.ben))
      assert.isTrue(yield* env.runs.markStarted(issue.id, env.ada))
      assert.strictEqual(yield* statusOf(env, issue.id), 'understanding')
    }).pipe(Effect.scoped)
  )

  it.effect('counts a hired agent with an in_review issue as busy', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.work.updateIssue(env.objective.id, env.issue.id, { status: 'in_review' })
      const { busyHires } = yield* env.runs.startCandidates
      assert.deepStrictEqual([...busyHires], [env.ada])
    }).pipe(Effect.scoped)
  )

  it.effect('requeues an implementing issue to todo and leaves an in_review issue as it is', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      const other = yield* createWorkIssue(env, 2, env.objective.id, env.ben)
      yield* env.runs.markStarted(other.id, env.ben)
      yield* env.work.updateIssue(env.objective.id, env.issue.id, { status: 'implementing' })
      yield* env.work.updateIssue(env.objective.id, other.id, { status: 'in_review' })
      assert.strictEqual(yield* env.runs.requeueRunning, 1)
      assert.deepStrictEqual(
        [yield* statusOf(env, env.issue.id), yield* statusOf(env, other.id)],
        ['todo', 'in_review']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('does not requeue an in_review issue whose session ended', () =>
    Effect.gen(function* () {
      const env = yield* withStartedIssue
      yield* env.work.updateIssue(env.objective.id, env.issue.id, { status: 'in_review' })
      assert.isFalse(yield* env.runs.markRequeued(env.issue.id, true))
      assert.strictEqual(yield* statusOf(env, env.issue.id), 'in_review')
    }).pipe(Effect.scoped)
  )
})
