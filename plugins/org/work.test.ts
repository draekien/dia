import { ProjectId } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import {
  HireHasOpenTasks,
  ObjectiveId,
  ObjectiveNotFound,
  ProjectNotFound,
  TaskId,
  TaskNotFound,
  TaskNotRunning,
  TaskNotWaiting,
  WorkTitle
} from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeWork } from './work'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-400000000001')
const UNREGISTERED = ProjectId.make('00000000-0000-4000-8000-400000000002')
const objectiveId = (n: number) => ObjectiveId.make(`00000000-0000-4000-8000-5000000000${n}0`)
const taskId = (n: number) => TaskId.make(`00000000-0000-4000-8000-6000000000${n}0`)

const present = <A>(value: A | undefined, what: string): A => {
  assert.isDefined(value, what)
  return value as A
}

const openWork = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(scope))
  const built = yield* Effect.gen(function* () {
    const made = yield* makeWork((projectId) => Effect.succeed(projectId === PROJECT))
    const org = yield* makeOrg(made.openTasksOf)
    return { ...made, org }
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(NodeCrypto.layer))
  const engineer = present((yield* built.org.jobTitles)[0], 'a built-in job title')
  const ada = yield* built.org.hire(engineer.id, null, null)
  const ben = yield* built.org.hire(engineer.id, null, null)
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  return { ...built, sql, ada: ada.id, ben: ben.id }
})

const withObjective = Effect.gen(function* () {
  const env = yield* openWork
  const objective = yield* env.work.createObjective({
    id: objectiveId(1),
    projectId: PROJECT,
    title: WorkTitle.make('Ship the marketplace'),
    description: 'Let users install plugins.',
    priority: 'normal',
    assignee: null
  })
  return { ...env, objective }
})

const withRunningTask = Effect.gen(function* () {
  const env = yield* withObjective
  const task = yield* env.work.createTask({
    id: taskId(1),
    objectiveId: env.objective.id,
    parentTaskId: null,
    title: WorkTitle.make('Write the index fetcher'),
    assignee: env.ada
  })
  const started = yield* env.runs.markStarted(task.id, env.ada)
  assert.isTrue(started)
  return { ...env, task }
})

const countRows = (sql: SqlClient.SqlClient, table: 'tasks' | 'org_events' | 'objectives') =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`,
    ([row]) => row?.n ?? 0
  )

describe('Work.createObjective', () => {
  it.effect('refuses a project the workspace does not list', () =>
    Effect.gen(function* () {
      const { work } = yield* openWork
      const error = yield* work
        .createObjective({
          id: objectiveId(1),
          projectId: UNREGISTERED,
          title: WorkTitle.make('Anything'),
          description: '',
          priority: 'high',
          assignee: null
        })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, ProjectNotFound.make({ projectId: UNREGISTERED }))
    }).pipe(Effect.scoped)
  )

  it.effect('returns the stored objective and writes nothing when the id is repeated', () =>
    Effect.gen(function* () {
      const { work, sql, objective } = yield* withObjective
      const again = yield* work.createObjective({
        id: objective.id,
        projectId: PROJECT,
        title: WorkTitle.make('Another title'),
        description: '',
        priority: 'low',
        assignee: null
      })
      assert.deepStrictEqual(again, objective)
      assert.strictEqual(yield* countRows(sql, 'objectives'), 1)
      assert.strictEqual(yield* countRows(sql, 'org_events'), 1)
    }).pipe(Effect.scoped)
  )
})

describe('Work.createTask', () => {
  it.effect('refuses a missing objective', () =>
    Effect.gen(function* () {
      const { work } = yield* openWork
      const error = yield* work
        .createTask({
          id: taskId(1),
          objectiveId: objectiveId(9),
          parentTaskId: null,
          title: WorkTitle.make('Orphan'),
          assignee: null
        })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, ObjectiveNotFound.make({ objectiveId: objectiveId(9) }))
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a parent task of another objective', () =>
    Effect.gen(function* () {
      const { work, objective } = yield* withObjective
      yield* work.createObjective({
        id: objectiveId(2),
        projectId: PROJECT,
        title: WorkTitle.make('Other objective'),
        description: '',
        priority: 'normal',
        assignee: null
      })
      yield* work.createTask({
        id: taskId(1),
        objectiveId: objectiveId(2),
        parentTaskId: null,
        title: WorkTitle.make('Elsewhere'),
        assignee: null
      })
      const error = yield* work
        .createTask({
          id: taskId(2),
          objectiveId: objective.id,
          parentTaskId: taskId(1),
          title: WorkTitle.make('Child'),
          assignee: null
        })
        .pipe(Effect.flip)
      assert.deepStrictEqual(error, TaskNotFound.make({ taskId: taskId(1) }))
    }).pipe(Effect.scoped)
  )

  it.effect('leaves no task row when its event cannot be written', () =>
    Effect.gen(function* () {
      const { work, sql, objective } = yield* withObjective
      yield* sql.unsafe(
        "CREATE TRIGGER refuse_events BEFORE INSERT ON org_events BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
      const exit = yield* work
        .createTask({
          id: taskId(1),
          objectiveId: objective.id,
          parentTaskId: null,
          title: WorkTitle.make('Never stored'),
          assignee: null
        })
        .pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
      assert.strictEqual(yield* countRows(sql, 'tasks'), 0)
    }).pipe(Effect.scoped)
  )

  it.effect('reopens a completed objective', () =>
    Effect.gen(function* () {
      const env = yield* withRunningTask
      const finished = yield* env.work.finishTask(env.task.id)
      const retro = (yield* env.work.snapshot).tasks.find(
        (task) => task.parentTaskId === finished.id
      )
      assert.isDefined(retro)
      yield* env.work.assignTask(retro.id, env.ben)
      yield* env.runs.markStarted(retro.id, env.ben)
      yield* env.work.finishTask(retro.id)
      yield* env.work.createTask({
        id: taskId(5),
        objectiveId: env.objective.id,
        parentTaskId: null,
        title: WorkTitle.make('Follow-up'),
        assignee: null
      })
      const [objective] = (yield* env.work.snapshot).objectives
      assert.strictEqual(objective?.state, 'open')
    }).pipe(Effect.scoped)
  )
})

describe('Work.assignTask', () => {
  it.effect('refuses to give a running task to another hired agent', () =>
    Effect.gen(function* () {
      const { work, task, ben } = yield* withRunningTask
      const error = yield* work.assignTask(task.id, ben).pipe(Effect.flip)
      assert.deepStrictEqual(error, TaskNotWaiting.make({ taskId: task.id, state: 'running' }))
    }).pipe(Effect.scoped)
  )

  it.effect('returns a running task unchanged when given its current assignee again', () =>
    Effect.gen(function* () {
      const { work, task, ada } = yield* withRunningTask
      const again = yield* work.assignTask(task.id, ada)
      assert.strictEqual(again.state, 'running')
      assert.strictEqual(again.assignee, ada)
    }).pipe(Effect.scoped)
  )
})

describe('Work.finishTask', () => {
  it.effect('refuses a task that never ran', () =>
    Effect.gen(function* () {
      const { work, objective } = yield* withObjective
      const task = yield* work.createTask({
        id: taskId(1),
        objectiveId: objective.id,
        parentTaskId: null,
        title: WorkTitle.make('Not started'),
        assignee: null
      })
      const error = yield* work.finishTask(task.id).pipe(Effect.flip)
      assert.deepStrictEqual(error, TaskNotRunning.make({ taskId: task.id }))
    }).pipe(Effect.scoped)
  )

  it.effect(
    'finishes a work task and gives it one unassigned waiting retro task, also when repeated',
    () =>
      Effect.gen(function* () {
        const { work, task } = yield* withRunningTask
        const first = yield* work.finishTask(task.id)
        const second = yield* work.finishTask(task.id)
        const retros = (yield* work.snapshot).tasks.filter((entry) => entry.kind === 'retro')
        assert.strictEqual(first.state, 'finished')
        assert.deepStrictEqual(second, first)
        assert.deepStrictEqual(
          retros.map((retro) => [retro.parentTaskId, retro.assignee, retro.state, retro.title]),
          [[task.id, null, 'waiting', 'Retro: Write the index fetcher']]
        )
      }).pipe(Effect.scoped)
  )

  it.effect(
    'keeps the finished task open until its retro task completes, then completes both and the objective',
    () =>
      Effect.gen(function* () {
        const env = yield* withRunningTask
        yield* env.work.finishTask(env.task.id)
        const retro = present(
          (yield* env.work.snapshot).tasks.find((entry) => entry.kind === 'retro'),
          'the retro task'
        )
        yield* env.work.assignTask(retro.id, env.ben)
        yield* env.runs.markStarted(retro.id, env.ben)
        const beforeRetro = (yield* env.work.snapshot).tasks.find(
          (entry) => entry.id === env.task.id
        )
        assert.strictEqual(beforeRetro?.state, 'finished')

        yield* env.work.finishTask(retro.id)

        const snapshot = yield* env.work.snapshot
        assert.deepStrictEqual(
          snapshot.tasks.map((entry) => entry.state),
          ['completed', 'completed']
        )
        assert.strictEqual(snapshot.objectives[0]?.state, 'completed')
      }).pipe(Effect.scoped)
  )
})

describe('Org.dismiss with tasks', () => {
  it.effect('refuses a hired agent assigned to a task that is not completed', () =>
    Effect.gen(function* () {
      const { org, ada } = yield* withRunningTask
      const error = yield* org.dismiss(ada).pipe(Effect.flip)
      assert.deepStrictEqual(error, HireHasOpenTasks.make({ hireId: ada, tasks: 1 }))
    }).pipe(Effect.scoped)
  )
})

describe('TaskRuns', () => {
  it.effect('starts a waiting task only for the hired agent it is assigned to', () =>
    Effect.gen(function* () {
      const { work, runs, objective, ada, ben } = yield* withObjective
      const task = yield* work.createTask({
        id: taskId(1),
        objectiveId: objective.id,
        parentTaskId: null,
        title: WorkTitle.make('Assigned to Ada'),
        assignee: ada
      })
      assert.isFalse(yield* runs.markStarted(task.id, ben))
      assert.isTrue(yield* runs.markStarted(task.id, ada))
    }).pipe(Effect.scoped)
  )

  it.effect('moves every running task back to waiting on a new setup', () =>
    Effect.gen(function* () {
      const { work, runs } = yield* withRunningTask
      assert.strictEqual(yield* runs.requeueRunning, 1)
      assert.deepStrictEqual(
        (yield* work.snapshot).tasks.map((task) => task.state),
        ['waiting']
      )
    }).pipe(Effect.scoped)
  )
})
