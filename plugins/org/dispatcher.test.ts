import {
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  BackgroundTasksChanged,
  type ModelOption,
  type OutboundMessage,
  PermissionRequested,
  ProjectId,
  QuestionRequested,
  type SessionEnd,
  SessionId,
  SessionNotFound,
  SessionStarted,
  ToolCallStarted,
  TurnCompleted,
  TurnStatusChanged
} from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { DateTime, Deferred, Effect, Exit, Option, Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { makeDispatcher } from './dispatcher'
import {
  type HiredAgent,
  type JobTitle,
  ObjectiveId,
  type ObjectivePriority,
  OverallCap,
  type Task,
  TaskId,
  WorkTitle
} from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeWork } from './work'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-400000000001')
const DIRECTORY = 'F:/repos/marketplace'
const OBJECTIVE = ObjectiveId.make('00000000-0000-4000-8000-500000000001')
const ALLOW = { _tag: 'Allow' } as const

const model = (value: string, autoMode: boolean): ModelOption => ({
  value,
  displayName: value,
  description: '',
  adaptiveThinking: true,
  effortLevels: [],
  autoMode,
  fastMode: false
})

const CATALOG = [model('default', false), model('opus', true)]

interface FakeSession {
  readonly options: AgentSessionOptions
  readonly sent: Array<string>
  readonly resolved: Array<string>
  readonly end: Deferred.Deferred<SessionEnd>
  closed: boolean
}

const fakeBackend = (disabled: ReadonlyArray<'auto' | 'bypassPermissions'> = []) => {
  const sessions: Array<FakeSession> = []
  const backend = {
    openSession: (options: AgentSessionOptions) =>
      Effect.gen(function* () {
        const session: FakeSession = {
          options,
          sent: [],
          resolved: [],
          end: yield* Deferred.make<SessionEnd>(),
          closed: false
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            session.closed = true
          })
        )
        sessions.push(session)
        return {
          sendText: (text: string) => Effect.sync(() => session.sent.push(text)),
          resolvePermission: (requestId: string) =>
            Effect.sync(() => session.resolved.push(requestId)),
          ended: Deferred.await(session.end)
        } as unknown as AgentSession
      }),
    models: () =>
      Stream.make({
        _tag: 'Ready',
        models: CATALOG,
        fetchedAt: DateTime.makeUnsafe(0),
        refreshing: false
      }),
    disabledPermissionModes: () => Effect.succeed(disabled)
  } as unknown as AgentBackend
  return { backend, sessions }
}

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow
})

const setUp = (options: {
  readonly cap: number
  readonly disabled?: ReadonlyArray<'auto' | 'bypassPermissions'>
}) =>
  Effect.gen(function* () {
    const dbScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(dbScope, Exit.void))
    const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(dbScope))
    const { work, runs, org } = yield* Effect.gen(function* () {
      const made = yield* makeWork((projectId) => Effect.succeed(projectId === PROJECT))
      return { ...made, org: yield* makeOrg(made.openTasksOf) }
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(NodeCrypto.layer))
    yield* org.setOverallCap(OverallCap.make(options.cap))
    const dispatcher = yield* makeDispatcher({
      runs,
      org,
      projectDirectory: (objective) =>
        Effect.succeed(objective.projectId === PROJECT ? Option.some(DIRECTORY) : Option.none())
    })
    const fake = fakeBackend(options.disabled)
    yield* dispatcher.lendBackend(fake.backend)
    yield* work.createObjective({
      id: OBJECTIVE,
      projectId: PROJECT,
      title: WorkTitle.make('Ship the marketplace'),
      description: 'Let users install plugins.',
      priority: 'normal',
      assignee: null
    })
    yield* settle
    const jobTitles = yield* org.jobTitles
    const hireOf = (jobTitle: JobTitle) => org.hire(jobTitle.id, null, null)
    let taskCount = 0
    const addTask = (assignee: HiredAgent, priority: ObjectivePriority = 'normal') =>
      Effect.gen(function* () {
        taskCount += 1
        const objectiveId =
          priority === 'normal'
            ? OBJECTIVE
            : (yield* work.createObjective({
                id: ObjectiveId.make(
                  `00000000-0000-4000-8000-5${String(taskCount).padStart(11, '0')}`
                ),
                projectId: PROJECT,
                title: WorkTitle.make(`A ${priority} objective`),
                description: '',
                priority,
                assignee: null
              })).id
        const task = yield* work.createTask({
          id: TaskId.make(`00000000-0000-4000-8000-6${String(taskCount).padStart(11, '0')}`),
          objectiveId,
          parentTaskId: null,
          title: WorkTitle.make(`Task ${taskCount}`),
          assignee: assignee.id
        })
        yield* dispatcher.signal
        yield* settle
        return task
      })
    const taskOf = (session: FakeSession) =>
      Effect.map(work.snapshot, (snapshot) => {
        const task = snapshot.tasks.find((entry) => entry.paneId === session.options.config.paneId)
        assert.isDefined(task, 'the task of an opened session')
        return task as Task
      })
    const emit = (session: FakeSession, message: OutboundMessage) =>
      session.options.emit(message).pipe(Effect.andThen(settle))
    const finish = (task: Task) =>
      work
        .finishTask(task.id)
        .pipe(Effect.andThen(dispatcher.release(task.id)), Effect.andThen(settle))
    return {
      work,
      runs,
      org,
      dispatcher,
      ...fake,
      jobTitles,
      hireOf,
      addTask,
      taskOf,
      emit,
      finish
    }
  })

const open = (sessions: ReadonlyArray<FakeSession>) => sessions.filter((session) => !session.closed)

describe('dispatcher caps', () => {
  it.effect(
    'never holds more slots than the cap, nor runs more agents of a job title than it has hires, across 60 tasks',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp({ cap: 3 })
        const [productManager, engineer, qualityEngineer] = env.jobTitles
        assert.isDefined(qualityEngineer)
        const hiresByJobTitle = new Map<string, number>()
        const hires: Array<HiredAgent> = []
        for (const [jobTitle, count] of [
          [engineer, 2],
          [productManager, 3],
          [qualityEngineer, 1]
        ] as const) {
          if (jobTitle === undefined) continue
          hiresByJobTitle.set(jobTitle.id, count)
          for (let n = 0; n < count; n += 1) hires.push(yield* env.hireOf(jobTitle))
        }
        const jobTitleOfHire = new Map(hires.map((hire) => [hire.id, hire.jobTitleId]))
        const priorities: ReadonlyArray<ObjectivePriority> = ['normal', 'high', 'low']
        for (let n = 0; n < 60; n += 1) {
          const hire = hires[n % hires.length]
          if (hire !== undefined) yield* env.addTask(hire, priorities[n % 3])
        }
        let maxHeld = 0
        let finished = 0
        while (finished < 60) {
          const live = yield* env.dispatcher.live
          maxHeld = Math.max(maxHeld, live.heldSlots)
          const running = new Map<string, number>()
          for (const session of open(env.sessions)) {
            const task = yield* env.taskOf(session)
            const jobTitleId =
              task.assignee === null ? '' : (jobTitleOfHire.get(task.assignee) ?? '')
            running.set(jobTitleId, (running.get(jobTitleId) ?? 0) + 1)
          }
          for (const [jobTitleId, count] of running) {
            assert.isAtMost(count, hiresByJobTitle.get(jobTitleId) ?? 0)
          }
          const [session] = open(env.sessions)
          assert.isDefined(session, `no session open after ${finished} finished tasks`)
          const task = yield* env.taskOf(session as FakeSession)
          if (finished % 3 === 0) {
            yield* env.emit(
              session as FakeSession,
              PermissionRequested.make({ requestId: `r${finished}`, toolName: 'Bash', input: {} })
            )
          } else if (finished % 3 === 1) {
            yield* env.emit(
              session as FakeSession,
              BackgroundTasksChanged.make({ tasks: [{ taskId: 'b', description: 'tests' }] })
            )
            yield* env.emit(session as FakeSession, TurnCompleted.make({}))
          } else {
            yield* env.emit(session as FakeSession, TurnCompleted.make({}))
          }
          yield* env.finish(task)
          finished += 1
        }
        assert.strictEqual(maxHeld, 3)
        assert.strictEqual(env.sessions.length, 60)
      }).pipe(Effect.scoped)
  )
})

describe('dispatcher session start', () => {
  it.effect(
    'opens the session with the job title model, thinking, tools, job description and auto mode',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp({ cap: 2 })
        const engineer = env.jobTitles[1]
        assert.isDefined(engineer)
        const edited = yield* env.org.editJobTitle((engineer as JobTitle).id, {
          model: 'opus',
          thinkingLevel: 'high'
        })
        const task = yield* env.addTask(yield* env.hireOf(edited))

        const [session] = env.sessions
        assert.isDefined(session)
        const { options, sent } = session as FakeSession
        assert.deepStrictEqual(options.config, {
          paneId: task.paneId,
          cwd: DIRECTORY,
          model: 'opus',
          thinkingLevel: 'high',
          permissionMode: 'auto'
        })
        assert.strictEqual(options.systemPromptAppend, edited.jobDescription)
        assert.deepStrictEqual(
          options.tools,
          Option.some({ permissions: edited.permissions, mcpServers: edited.mcpServers })
        )
        assert.isTrue(Option.isNone(options.resume))
        assert.deepStrictEqual(sent, [
          'Task 1\n\nObjective: Ship the marketplace\n\nLet users install plugins.'
        ])
      }).pipe(Effect.scoped)
  )

  it.effect(
    'uses the first catalog model when the job title has none, and bypass when opted in without auto',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp({ cap: 2 })
        const engineer = env.jobTitles[1] as JobTitle
        yield* env.org.editJobTitle(engineer.id, { bypassOptIn: true })
        yield* env.addTask(yield* env.hireOf(engineer))

        const config = env.sessions[0]?.options.config
        assert.strictEqual(config?.model, 'default')
        assert.strictEqual(config?.permissionMode, 'bypassPermissions')
      }).pipe(Effect.scoped)
  )

  it.effect(
    'starts in default when settings disable auto and the job title does not opt into bypass',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp({ cap: 2, disabled: ['auto'] })
        const engineer = env.jobTitles[1] as JobTitle
        yield* env.org.editJobTitle(engineer.id, { model: 'opus' })
        yield* env.addTask(yield* env.hireOf(engineer))

        assert.strictEqual(env.sessions[0]?.options.config.permissionMode, 'default')
      }).pipe(Effect.scoped)
  )
})

describe('dispatcher slots', () => {
  it.effect('starts the next waiting task when a running agent waits on a permission request', () =>
    Effect.gen(function* () {
      const env = yield* setUp({ cap: 1 })
      const engineer = env.jobTitles[1] as JobTitle
      yield* env.addTask(yield* env.hireOf(engineer))
      yield* env.addTask(yield* env.hireOf(engineer))
      assert.strictEqual(env.sessions.length, 1)

      yield* env.emit(
        env.sessions[0] as FakeSession,
        PermissionRequested.make({ requestId: 'r1', toolName: 'Bash', input: {} })
      )

      assert.strictEqual(env.sessions.length, 2)
      assert.deepStrictEqual(
        (yield* env.dispatcher.live).pendingPermissions.map((p) => p.requestId),
        ['r1']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('resumes an answered agent one over the cap, ahead of a waiting task', () =>
    Effect.gen(function* () {
      const env = yield* setUp({ cap: 1 })
      const engineer = env.jobTitles[1] as JobTitle
      const first = yield* env.addTask(yield* env.hireOf(engineer))
      yield* env.emit(
        env.sessions[0] as FakeSession,
        PermissionRequested.make({ requestId: 'r1', toolName: 'Bash', input: {} })
      )
      yield* env.addTask(yield* env.hireOf(engineer))
      yield* env.addTask(yield* env.hireOf(engineer))
      assert.strictEqual(env.sessions.length, 2)

      yield* env.dispatcher.answerPermission(first.id, 'r1', ALLOW)
      yield* settle

      assert.deepStrictEqual(env.sessions[0]?.resolved, ['r1'])
      assert.strictEqual((yield* env.dispatcher.live).heldSlots, 2)
      assert.strictEqual(env.sessions.length, 2)
    }).pipe(Effect.scoped)
  )

  it.effect('accepts a repeated answer, and refuses an answer to a request never made', () =>
    Effect.gen(function* () {
      const env = yield* setUp({ cap: 1 })
      const task = yield* env.addTask(yield* env.hireOf(env.jobTitles[1] as JobTitle))
      yield* env.emit(
        env.sessions[0] as FakeSession,
        PermissionRequested.make({ requestId: 'r1', toolName: 'Bash', input: {} })
      )

      yield* env.dispatcher.answerPermission(task.id, 'r1', ALLOW)
      yield* env.dispatcher.answerPermission(task.id, 'r1', ALLOW)
      const refused = yield* env.dispatcher.answerPermission(task.id, 'r9', ALLOW).pipe(Effect.flip)

      assert.strictEqual(refused._tag, 'PermissionNotPending')
    }).pipe(Effect.scoped)
  )

  it.effect('keeps the agent waiting while a second request is unanswered', () =>
    Effect.gen(function* () {
      const env = yield* setUp({ cap: 1 })
      const task = yield* env.addTask(yield* env.hireOf(env.jobTitles[1] as JobTitle))
      const session = env.sessions[0] as FakeSession
      yield* env.emit(
        session,
        PermissionRequested.make({ requestId: 'r1', toolName: 'Bash', input: {} })
      )
      yield* env.emit(
        session,
        PermissionRequested.make({ requestId: 'r2', toolName: 'Edit', input: {} })
      )

      yield* env.dispatcher.answerPermission(task.id, 'r1', ALLOW)
      yield* settle

      assert.deepStrictEqual(session.resolved, ['r1'])
      assert.strictEqual((yield* env.dispatcher.live).heldSlots, 0)
    }).pipe(Effect.scoped)
  )

  it.effect('holds the slot while background work runs after the turn ends', () =>
    Effect.gen(function* () {
      const env = yield* setUp({ cap: 1 })
      const engineer = env.jobTitles[1] as JobTitle
      yield* env.addTask(yield* env.hireOf(engineer))
      yield* env.addTask(yield* env.hireOf(engineer))
      const session = env.sessions[0] as FakeSession

      yield* env.emit(
        session,
        BackgroundTasksChanged.make({ tasks: [{ taskId: 'b1', description: 'build' }] })
      )
      yield* env.emit(session, TurnCompleted.make({}))
      const whileBackground = env.sessions.length
      yield* env.emit(session, BackgroundTasksChanged.make({ tasks: [] }))

      assert.strictEqual(whileBackground, 1)
      assert.strictEqual(env.sessions.length, 2)
    }).pipe(Effect.scoped)
  )

  it.effect(
    'takes the slot again when an agent answered elsewhere resumes, but not for status events after its turn',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp({ cap: 2 })
        yield* env.addTask(yield* env.hireOf(env.jobTitles[1] as JobTitle))
        const session = env.sessions[0] as FakeSession

        yield* env.emit(session, TurnCompleted.make({}))
        yield* env.emit(session, TurnStatusChanged.make({ label: null }))
        const afterStatus = (yield* env.dispatcher.live).heldSlots
        yield* env.emit(session, QuestionRequested.make({ requestId: 'q1', questions: [] }))
        yield* env.emit(session, ToolCallStarted.make({ toolCallId: 't1', toolName: 'Read' }))

        assert.strictEqual(afterStatus, 0)
        assert.strictEqual((yield* env.dispatcher.live).heldSlots, 1)
      }).pipe(Effect.scoped)
  )
})

describe('dispatcher session end', () => {
  it.effect('starts a fresh session when the resumed conversation no longer exists', () =>
    Effect.gen(function* () {
      const env = yield* setUp({ cap: 1 })
      const task = yield* env.addTask(yield* env.hireOf(env.jobTitles[1] as JobTitle))
      const first = env.sessions[0] as FakeSession
      const sessionId = SessionId.make('00000000-0000-4000-8000-700000000001')
      yield* env.emit(first, SessionStarted.make({ sessionId }))

      yield* Deferred.succeed(first.end, SessionNotFound.make({ sessionId }))
      yield* settle

      const second = env.sessions[1]
      assert.isTrue(first.closed)
      assert.isDefined(second)
      assert.isTrue(Option.isNone((second as FakeSession).options.resume))
      assert.strictEqual((second as FakeSession).options.config.paneId, task.paneId)
    }).pipe(Effect.scoped)
  )

  it.effect('resumes the stored session when a new setup starts the task again', () =>
    Effect.gen(function* () {
      const env = yield* setUp({ cap: 1 })
      yield* env.addTask(yield* env.hireOf(env.jobTitles[1] as JobTitle))
      const sessionId = SessionId.make('00000000-0000-4000-8000-700000000002')
      yield* env.emit(env.sessions[0] as FakeSession, SessionStarted.make({ sessionId }))
      const nextSetup = yield* makeDispatcher({
        runs: env.runs,
        org: env.org,
        projectDirectory: () => Effect.succeed(Option.some(DIRECTORY))
      })
      yield* nextSetup.lendBackend(env.backend)
      yield* settle

      const resumed = env.sessions[1] as FakeSession
      assert.deepStrictEqual(resumed.options.resume, Option.some(sessionId))
      assert.deepStrictEqual(resumed.sent, ['continue'])
    }).pipe(Effect.scoped)
  )
})

const countChanges = (watchChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>) =>
  Effect.gen(function* () {
    const changes = yield* watchChanges
    let count = 0
    yield* changes.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          count += 1
        })
      ),
      Effect.forkScoped
    )
    yield* settle
    return () => count
  })

const changesDuring = <A, E, R>(count: () => number, action: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = count()
    yield* action
    yield* settle
    return count() - before
  })

describe('dispatcher change signal', () => {
  it.effect(
    'emits when a task is reserved, waits on a permission, is answered and is dropped',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp({ cap: 1 })
        const count = yield* countChanges(env.dispatcher.watchChanges)
        const engineer = env.jobTitles[1] as JobTitle
        const hire = yield* env.hireOf(engineer)
        let task: Task | undefined
        const reserved = yield* changesDuring(
          count,
          Effect.map(env.addTask(hire), (added) => {
            task = added
          })
        )
        const session = env.sessions[0] as FakeSession
        const pending = yield* changesDuring(
          count,
          env.emit(
            session,
            PermissionRequested.make({ requestId: 'r1', toolName: 'Bash', input: {} })
          )
        )
        const answered = yield* changesDuring(
          count,
          env.dispatcher.answerPermission((task as Task).id, 'r1', ALLOW)
        )
        const dropped = yield* changesDuring(count, env.dispatcher.release((task as Task).id))

        assert.deepStrictEqual(
          [reserved > 0, pending > 0, answered > 0, dropped > 0],
          [true, true, true, true]
        )
      }).pipe(Effect.scoped)
  )

  it.effect(
    'does not emit for activity during a running turn, a pass that starts nothing, or dropping an absent task',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp({ cap: 1 })
        const engineer = env.jobTitles[1] as JobTitle
        yield* env.addTask(yield* env.hireOf(engineer))
        const session = env.sessions[0] as FakeSession
        yield* env.emit(session, ToolCallStarted.make({ toolCallId: 't0', toolName: 'Read' }))
        const count = yield* countChanges(env.dispatcher.watchChanges)

        const activity = yield* changesDuring(
          count,
          env.emit(session, ToolCallStarted.make({ toolCallId: 't1', toolName: 'Read' }))
        )
        const idlePass = yield* changesDuring(count, env.dispatcher.signal)
        const absent = yield* changesDuring(
          count,
          env.dispatcher.release(TaskId.make('00000000-0000-4000-8000-699999999999'))
        )

        assert.deepStrictEqual([activity, idlePass, absent], [0, 0, 0])
      }).pipe(Effect.scoped)
  )
})
