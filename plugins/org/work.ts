import { type ProjectId, SessionId, Uuid } from '@dia/plugin'
import { Clock, Crypto, Effect, Schema } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import {
  HireId,
  HireNotFound,
  type NewObjective,
  type NewTask,
  Objective,
  type ObjectiveId,
  ObjectiveNotFound,
  ProjectNotFound,
  Task,
  type TaskId,
  TaskNotFound,
  TaskNotRunning,
  TaskNotWaiting,
  WORK_TITLE_MAX_LENGTH,
  WorkSnapshot,
  WorkTitle
} from './domain'

const ObjectiveCreated = Schema.TaggedStruct('ObjectiveCreated', { objective: Objective })
const ObjectiveReopened = Schema.TaggedStruct('ObjectiveReopened', {})
const ObjectiveCompleted = Schema.TaggedStruct('ObjectiveCompleted', {})
const TaskCreated = Schema.TaggedStruct('TaskCreated', { task: Task })
const TaskAssigned = Schema.TaggedStruct('TaskAssigned', { assignee: Task.fields.assignee })
const TaskStarted = Schema.TaggedStruct('TaskStarted', { assignee: HireId })
const TaskSessionStarted = Schema.TaggedStruct('TaskSessionStarted', { sessionId: SessionId })
const TaskRequeued = Schema.TaggedStruct('TaskRequeued', { sessionId: Task.fields.sessionId })
const TaskFinished = Schema.TaggedStruct('TaskFinished', {})
const TaskCompleted = Schema.TaggedStruct('TaskCompleted', {})

const OrgEvent = Schema.Union([
  ObjectiveCreated,
  ObjectiveReopened,
  ObjectiveCompleted,
  TaskCreated,
  TaskAssigned,
  TaskStarted,
  TaskSessionStarted,
  TaskRequeued,
  TaskFinished,
  TaskCompleted
])
type OrgEvent = typeof OrgEvent.Type

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrgEvent))

const ObjectiveRow = Schema.Struct({
  objective_id: Objective.fields.id,
  project_id: Objective.fields.projectId,
  title: Objective.fields.title,
  description: Objective.fields.description,
  priority: Objective.fields.priority,
  assignee: Objective.fields.assignee,
  state: Objective.fields.state,
  created_at: Objective.fields.createdAt
})

const TaskRow = Schema.Struct({
  task_id: Task.fields.id,
  objective_id: Task.fields.objectiveId,
  parent_task_id: Task.fields.parentTaskId,
  kind: Task.fields.kind,
  title: Task.fields.title,
  state: Task.fields.state,
  assignee: Task.fields.assignee,
  pane_id: Task.fields.paneId,
  session_id: Task.fields.sessionId,
  created_at: Task.fields.createdAt
})

const toObjective = (row: typeof ObjectiveRow.Type): Objective => ({
  id: row.objective_id,
  projectId: row.project_id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  assignee: row.assignee,
  state: row.state,
  createdAt: row.created_at
})

const toTask = (row: typeof TaskRow.Type): Task => ({
  id: row.task_id,
  objectiveId: row.objective_id,
  parentTaskId: row.parent_task_id,
  kind: row.kind,
  title: row.title,
  state: row.state,
  assignee: row.assignee,
  paneId: row.pane_id,
  sessionId: row.session_id,
  createdAt: row.created_at
})

const encodeObjectiveRow = Schema.encodeSync(ObjectiveRow)
const encodeTaskRow = Schema.encodeSync(TaskRow)

const toObjectiveRow = (objective: Objective) =>
  encodeObjectiveRow({
    objective_id: objective.id,
    project_id: objective.projectId,
    title: objective.title,
    description: objective.description,
    priority: objective.priority,
    assignee: objective.assignee,
    state: objective.state,
    created_at: objective.createdAt
  })

const toTaskRow = (task: Task) =>
  encodeTaskRow({
    task_id: task.id,
    objective_id: task.objectiveId,
    parent_task_id: task.parentTaskId,
    kind: task.kind,
    title: task.title,
    state: task.state,
    assignee: task.assignee,
    pane_id: task.paneId,
    session_id: task.sessionId,
    created_at: task.createdAt
  })

const decodeObjectiveRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(ObjectiveRow))(rows).pipe(Effect.orDie)
const decodeTaskRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(TaskRow))(rows).pipe(Effect.orDie)

const retroTitle = (title: WorkTitle): WorkTitle =>
  WorkTitle.make(`Retro: ${title}`.slice(0, WORK_TITLE_MAX_LENGTH).trimEnd())

/**
 * The objectives and tasks (ADR-0033, ADR-0064), as the `org` plugin's calls read and change them.
 * Each change is one transaction that writes its events and the changed rows, and is safe to
 * repeat. A database failure, or a failure to generate an id, is a defect.
 *
 * `createObjective` creates an open objective, or returns the stored one when `id` exists.
 * `createTask` creates a waiting `work` task, or returns the stored one when `id` exists; it
 * reopens a completed objective. `assignTask` sets a waiting task's assignee, or clears it when
 * null; giving a task its current assignee returns it unchanged in any state. `finishTask` moves a
 * running `work` task to `finished` and creates its unassigned `retro` task, or moves a running
 * `retro` task, and the task it reviews, to `completed`; on a `finished` or `completed` task it
 * returns the task unchanged.
 */
export interface Work {
  readonly snapshot: Effect.Effect<WorkSnapshot>
  readonly createObjective: (
    input: NewObjective
  ) => Effect.Effect<Objective, ProjectNotFound | HireNotFound>
  readonly createTask: (
    input: NewTask
  ) => Effect.Effect<Task, ObjectiveNotFound | TaskNotFound | HireNotFound>
  readonly assignTask: (
    taskId: TaskId,
    hireId: HireId | null
  ) => Effect.Effect<Task, TaskNotFound | TaskNotWaiting | HireNotFound>
  readonly finishTask: (taskId: TaskId) => Effect.Effect<Task, TaskNotFound | TaskNotRunning>
}

/** A waiting task with an assignee, and its objective: one candidate for the scheduler. */
export interface WaitingTask {
  readonly task: Task
  readonly objective: Objective
}

/**
 * The task changes only the dispatcher makes, as it starts and loses sessions. Each changes a task
 * only in the state it expects and reports whether it did. `markStarted` moves a waiting task
 * assigned to `hireId` to `running`. `markSessionStarted` stores the session a running task
 * resumes next. `markRequeued` moves a running task back to `waiting`, keeping its session, or
 * clearing it when `keepSession` is false. `requeueRunning` moves every running task back to
 * `waiting` and returns how many it moved.
 */
export interface TaskRuns {
  readonly startCandidates: Effect.Effect<{
    readonly waiting: ReadonlyArray<WaitingTask>
    readonly busyHires: ReadonlySet<HireId>
  }>
  readonly markStarted: (taskId: TaskId, hireId: HireId) => Effect.Effect<boolean>
  readonly markSessionStarted: (taskId: TaskId, sessionId: SessionId) => Effect.Effect<boolean>
  readonly markRequeued: (taskId: TaskId, keepSession: boolean) => Effect.Effect<boolean>
  readonly requeueRunning: Effect.Effect<number>
}

/**
 * Builds the {@link Work}, the dispatcher's {@link TaskRuns}, and `openTasksOf` (the number of
 * tasks assigned to a hired agent that are not completed, which `makeOrg` takes) over the `org`
 * plugin's database, which `orgMigrations` must already have migrated. `projectExists` says
 * whether a project is registered now. Call it once in the plugin's setup.
 */
export const makeWork = (projectExists: (projectId: ProjectId) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto

    const transaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
      sql.withTransaction(effect).pipe(Effect.catchTag('SqlError', Effect.die))
    const orDie = <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
      effect.pipe(Effect.catchTag('SqlError', Effect.die))

    const newUuid = crypto.randomUUIDv4().pipe(Effect.orDie)

    const append = (objectiveId: ObjectiveId, taskId: TaskId | null, event: OrgEvent) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* sql`INSERT INTO org_events ${sql.insert({
          at,
          objective_id: objectiveId,
          task_id: taskId,
          event: encodeEvent(event)
        })}`
      })

    const findObjective = Effect.fnUntraced(function* (objectiveId: ObjectiveId) {
      const rows = yield* sql`SELECT * FROM objectives WHERE objective_id = ${objectiveId}`
      const [row] = yield* decodeObjectiveRows(rows)
      return row === undefined ? undefined : toObjective(row)
    })

    const findTask = Effect.fnUntraced(function* (taskId: TaskId) {
      const rows = yield* sql`SELECT * FROM tasks WHERE task_id = ${taskId}`
      const [row] = yield* decodeTaskRows(rows)
      return row === undefined ? undefined : toTask(row)
    })

    const requireTask = Effect.fnUntraced(function* (taskId: TaskId) {
      const task = yield* findTask(taskId)
      if (task === undefined) {
        return yield* TaskNotFound.make({ taskId })
      }
      return task
    })

    const ensureHire = Effect.fnUntraced(function* (hireId: HireId | null) {
      if (hireId === null) return
      const rows = yield* sql`SELECT 1 FROM hired_agents WHERE hire_id = ${hireId}`
      if (rows.length === 0) {
        return yield* HireNotFound.make({ hireId })
      }
    })

    const setTaskState = (task: Task, state: Task['state']) =>
      sql`UPDATE tasks SET state = ${state} WHERE task_id = ${task.id}`

    const completeObjectiveIfDone = Effect.fnUntraced(function* (objectiveId: ObjectiveId) {
      const [counts] = yield* sql<{
        readonly total: number
        readonly open: number
      }>`SELECT count(*) AS total, count(*) FILTER (WHERE state <> 'completed') AS open
        FROM tasks WHERE objective_id = ${objectiveId}`
      if (counts !== undefined && counts.total > 0 && counts.open === 0) {
        yield* sql`UPDATE objectives SET state = 'completed' WHERE objective_id = ${objectiveId}`
        yield* append(objectiveId, null, ObjectiveCompleted.make({}))
        yield* Effect.logInfo('Completed objective', { objectiveId })
      }
    })

    const snapshot = Effect.gen(function* () {
      const objectives = yield* decodeObjectiveRows(
        yield* sql`SELECT * FROM objectives ORDER BY created_at, rowid`
      )
      const tasks = yield* decodeTaskRows(
        yield* sql`SELECT * FROM tasks ORDER BY created_at, rowid`
      )
      return WorkSnapshot.make({
        objectives: objectives.map(toObjective),
        tasks: tasks.map(toTask)
      })
    }).pipe(orDie)

    const createObjective = Effect.fn('Work.createObjective')(function* (input: NewObjective) {
      const createdAt = yield* Clock.currentTimeMillis
      const registered = yield* projectExists(input.projectId)
      const objective = yield* transaction(
        Effect.gen(function* () {
          const stored = yield* findObjective(input.id)
          if (stored !== undefined) return stored
          if (!registered) {
            return yield* ProjectNotFound.make({ projectId: input.projectId })
          }
          yield* ensureHire(input.assignee)
          const created = Objective.make({ ...input, state: 'open', createdAt })
          yield* sql`INSERT INTO objectives ${sql.insert(toObjectiveRow(created))}`
          yield* append(created.id, null, ObjectiveCreated.make({ objective: created }))
          return created
        })
      )
      yield* Effect.logInfo('Created objective', { objectiveId: objective.id })
      return objective
    })

    const createTask = Effect.fn('Work.createTask')(function* (input: NewTask) {
      const createdAt = yield* Clock.currentTimeMillis
      const paneId = Uuid.make(yield* newUuid)
      const task = yield* transaction(
        Effect.gen(function* () {
          const stored = yield* findTask(input.id)
          if (stored !== undefined) return stored
          const objective = yield* findObjective(input.objectiveId)
          if (objective === undefined) {
            return yield* ObjectiveNotFound.make({ objectiveId: input.objectiveId })
          }
          if (input.parentTaskId !== null) {
            const parent = yield* findTask(input.parentTaskId)
            if (parent === undefined || parent.objectiveId !== input.objectiveId) {
              return yield* TaskNotFound.make({ taskId: input.parentTaskId })
            }
          }
          yield* ensureHire(input.assignee)
          const created = Task.make({
            ...input,
            kind: 'work',
            state: 'waiting',
            paneId,
            sessionId: null,
            createdAt
          })
          yield* sql`INSERT INTO tasks ${sql.insert(toTaskRow(created))}`
          yield* append(created.objectiveId, created.id, TaskCreated.make({ task: created }))
          if (objective.state === 'completed') {
            yield* sql`UPDATE objectives SET state = 'open' WHERE objective_id = ${objective.id}`
            yield* append(objective.id, null, ObjectiveReopened.make({}))
          }
          return created
        })
      )
      yield* Effect.logInfo('Created task', { taskId: task.id, objectiveId: task.objectiveId })
      return task
    })

    const assignTask = Effect.fn('Work.assignTask')(function* (
      taskId: TaskId,
      hireId: HireId | null
    ) {
      const task = yield* transaction(
        Effect.gen(function* () {
          const current = yield* requireTask(taskId)
          if (current.assignee === hireId) return current
          if (current.state !== 'waiting') {
            return yield* TaskNotWaiting.make({ taskId, state: current.state })
          }
          yield* ensureHire(hireId)
          yield* sql`UPDATE tasks SET assignee = ${hireId} WHERE task_id = ${taskId}`
          yield* append(current.objectiveId, taskId, TaskAssigned.make({ assignee: hireId }))
          return Task.make({ ...current, assignee: hireId })
        })
      )
      yield* Effect.logInfo('Assigned task', { taskId, hireId })
      return task
    })

    const finishTask = Effect.fn('Work.finishTask')(function* (taskId: TaskId) {
      const createdAt = yield* Clock.currentTimeMillis
      const retroId = Task.fields.id.make(yield* newUuid)
      const retroPaneId = Uuid.make(yield* newUuid)
      const task = yield* transaction(
        Effect.gen(function* () {
          const current = yield* requireTask(taskId)
          if (current.state === 'finished' || current.state === 'completed') return current
          if (current.state === 'waiting') {
            return yield* TaskNotRunning.make({ taskId })
          }
          if (current.kind === 'work') {
            yield* setTaskState(current, 'finished')
            yield* append(current.objectiveId, taskId, TaskFinished.make({}))
            const retro = Task.make({
              id: retroId,
              objectiveId: current.objectiveId,
              parentTaskId: taskId,
              kind: 'retro',
              title: retroTitle(current.title),
              state: 'waiting',
              assignee: null,
              paneId: retroPaneId,
              sessionId: null,
              createdAt
            })
            yield* sql`INSERT INTO tasks ${sql.insert(toTaskRow(retro))}`
            yield* append(retro.objectiveId, retro.id, TaskCreated.make({ task: retro }))
            return Task.make({ ...current, state: 'finished' })
          }
          yield* setTaskState(current, 'completed')
          yield* append(current.objectiveId, taskId, TaskCompleted.make({}))
          const parent =
            current.parentTaskId === null ? undefined : yield* findTask(current.parentTaskId)
          if (parent !== undefined && parent.state === 'finished') {
            yield* setTaskState(parent, 'completed')
            yield* append(parent.objectiveId, parent.id, TaskCompleted.make({}))
          }
          yield* completeObjectiveIfDone(current.objectiveId)
          return Task.make({ ...current, state: 'completed' })
        })
      )
      yield* Effect.logInfo('Finished task', { taskId, kind: task.kind, state: task.state })
      return task
    })

    const openTasksOf = (hireId: HireId) =>
      sql<{
        readonly open: number
      }>`SELECT count(*) AS open FROM tasks WHERE assignee = ${hireId} AND state <> 'completed'`.pipe(
        Effect.map((rows) => rows[0]?.open ?? 0),
        orDie
      )

    const startCandidates = Effect.gen(function* () {
      const taskRows = yield* decodeTaskRows(
        yield* sql`SELECT * FROM tasks WHERE state = 'waiting' AND assignee IS NOT NULL ORDER BY created_at, rowid`
      )
      const objectiveRows = yield* decodeObjectiveRows(
        yield* sql`SELECT * FROM objectives WHERE objective_id IN (SELECT objective_id FROM tasks WHERE state = 'waiting' AND assignee IS NOT NULL)`
      )
      const objectives = new Map(objectiveRows.map((row) => [row.objective_id, toObjective(row)]))
      const busy = yield* sql<{
        readonly assignee: HireId
      }>`SELECT DISTINCT assignee FROM tasks WHERE state = 'running' AND assignee IS NOT NULL`
      const waiting = taskRows.flatMap((row) => {
        const objective = objectives.get(row.objective_id)
        return objective === undefined ? [] : [{ task: toTask(row), objective }]
      })
      return { waiting, busyHires: new Set(busy.map((row) => row.assignee)) }
    }).pipe(orDie)

    const changeRunning = (
      taskId: TaskId,
      update: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
      event: (task: Task) => OrgEvent
    ) =>
      transaction(
        Effect.gen(function* () {
          const changed = yield* decodeTaskRows(yield* update)
          const [row] = changed
          if (row === undefined) return false
          yield* append(row.objective_id, taskId, event(toTask(row)))
          return true
        })
      )

    const markStarted = (taskId: TaskId, hireId: HireId) =>
      changeRunning(
        taskId,
        sql`UPDATE tasks SET state = 'running' WHERE task_id = ${taskId} AND state = 'waiting' AND assignee = ${hireId} RETURNING *`,
        () => TaskStarted.make({ assignee: hireId })
      ).pipe(Effect.tap((changed) => Effect.logInfo('Marked task started', { taskId, changed })))

    const markSessionStarted = (taskId: TaskId, sessionId: SessionId) =>
      changeRunning(
        taskId,
        sql`UPDATE tasks SET session_id = ${sessionId} WHERE task_id = ${taskId} AND state = 'running' AND session_id IS NOT ${sessionId} RETURNING *`,
        () => TaskSessionStarted.make({ sessionId })
      ).pipe(Effect.tap((changed) => Effect.logDebug('Stored task session', { taskId, changed })))

    const markRequeued = (taskId: TaskId, keepSession: boolean) =>
      changeRunning(
        taskId,
        sql`UPDATE tasks SET state = 'waiting', session_id = CASE WHEN ${keepSession ? 1 : 0} THEN session_id END WHERE task_id = ${taskId} AND state = 'running' RETURNING *`,
        (task) => TaskRequeued.make({ sessionId: task.sessionId })
      ).pipe(
        Effect.tap((changed) => Effect.logInfo('Requeued task', { taskId, keepSession, changed }))
      )

    const requeueRunning = transaction(
      Effect.gen(function* () {
        const rows = yield* decodeTaskRows(
          yield* sql`UPDATE tasks SET state = 'waiting' WHERE state = 'running' RETURNING *`
        )
        for (const row of rows) {
          yield* append(
            row.objective_id,
            row.task_id,
            TaskRequeued.make({ sessionId: row.session_id })
          )
        }
        return rows.length
      })
    ).pipe(Effect.tap((count) => Effect.logInfo('Requeued running tasks', { count })))

    const work: Work = { snapshot, createObjective, createTask, assignTask, finishTask }
    const runs: TaskRuns = {
      startCandidates,
      markStarted,
      markSessionStarted,
      markRequeued,
      requeueRunning
    }
    return { work, runs, openTasksOf }
  })
