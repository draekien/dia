import {
  type AgentBackend,
  type AgentSession,
  type ModelOption,
  type OutboundMessage,
  type PermissionResponse,
  RESUME_TEXT,
  type SessionEnd,
  startPermissionMode
} from '@dia/plugin'
import {
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
  SynchronizedRef
} from 'effect'
import {
  type HiredAgent,
  type JobTitle,
  LiveWork,
  type Objective,
  PendingPermission,
  PermissionNotPending,
  type Task,
  type TaskId
} from './domain'
import { nextStarts } from './scheduler'
import type { Org } from './service'
import type { TaskRuns, WaitingTask } from './work'

type Turn = 'running' | 'awaiting-user' | 'idle'

interface QueuedAnswer {
  readonly requestId: string
  readonly response: PermissionResponse
  readonly order: number
}

interface LiveTask {
  readonly scope: Option.Option<Scope.Closeable>
  readonly session: Option.Option<AgentSession>
  readonly watcher: Option.Option<Fiber.Fiber<void>>
  readonly turn: Turn
  readonly background: number
  readonly pending: ReadonlyMap<string, PendingPermission>
  readonly queued: ReadonlyArray<QueuedAnswer>
  readonly answeredIds: ReadonlySet<string>
}

const reserved: LiveTask = {
  scope: Option.none(),
  session: Option.none(),
  watcher: Option.none(),
  turn: 'running',
  background: 0,
  pending: new Map(),
  queued: [],
  answeredIds: new Set()
}

const holdsSlot = (live: LiveTask) => live.turn === 'running' || live.background > 0

const ACTIVITY_EVENTS: ReadonlySet<OutboundMessage['_tag']> = new Set([
  'AssistantMessageReceived',
  'AssistantTextDelta',
  'AssistantThinkingDelta',
  'ToolCallStarted',
  'ToolCallCompleted',
  'ToolCallUpdated',
  'UserMessagesSent'
])

const applyEvent = (live: LiveTask, taskId: TaskId, message: OutboundMessage): LiveTask => {
  switch (message._tag) {
    case 'PermissionRequested': {
      const pending = new Map(live.pending)
      pending.set(
        message.requestId,
        PendingPermission.make({
          taskId,
          requestId: message.requestId,
          toolName: message.toolName,
          input: message.input
        })
      )
      return { ...live, turn: 'awaiting-user', pending }
    }
    case 'QuestionRequested':
    case 'PlanReviewRequested':
      return { ...live, turn: 'awaiting-user' }
    case 'TurnCompleted':
    case 'TurnErrored':
    case 'TurnParked':
      return { ...live, turn: 'idle' }
    case 'BackgroundTasksChanged':
      return { ...live, background: message.tasks.length }
    default:
      return ACTIVITY_EVENTS.has(message._tag) &&
        live.turn !== 'running' &&
        live.pending.size === 0 &&
        live.queued.length === 0
        ? { ...live, turn: 'running' }
        : live
  }
}

const promptFor = (task: Task, objective: Objective) =>
  task.sessionId !== null
    ? RESUME_TEXT
    : `${task.title}\n\nObjective: ${objective.title}\n\n${objective.description}`

/** Where a task's session runs: the registered directory of its objective's project. */
export type ProjectDirectory = (objective: Objective) => Effect.Effect<Option.Option<string>>

/**
 * Runs hired agents' tasks as headless sessions within the overall cap (ADR-0033, ADR-0067).
 * `signal` asks for a scheduling pass; call it after any change that can start or resume a task.
 * `lendBackend` lends the dispatcher an agent backend until the calling scope closes; with none,
 * nothing starts. `answerPermission` queues the user's answer to a pending permission request; the
 * agent resumes ahead of waiting tasks, up to one over the overall cap. `release` stops the task's
 * session, if any, and lets a task whose session failed start again; call it after the task is
 * finished or reassigned. `live` reads the pending permission requests and the held slots.
 * `watchChanges` subscribes when run; the stream it returns emits once each time `live` may read
 * differently since the subscription.
 */
export interface Dispatcher {
  readonly signal: Effect.Effect<void>
  readonly lendBackend: (backend: AgentBackend) => Effect.Effect<void, never, Scope.Scope>
  readonly answerPermission: (
    taskId: TaskId,
    requestId: string,
    response: PermissionResponse
  ) => Effect.Effect<void, PermissionNotPending>
  readonly release: (taskId: TaskId) => Effect.Effect<void>
  readonly live: Effect.Effect<LiveWork>
  readonly watchChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
}

interface StartContext {
  readonly task: Task
  readonly objective: Objective
  readonly hire: HiredAgent
  readonly jobTitle: JobTitle
  readonly directory: string
}

/**
 * Builds the {@link Dispatcher} for the `org` plugin's setup scope. It requeues every task left
 * `running` by an earlier setup, so each resumes its session when it next starts, and it closes
 * every session when the scope closes.
 */
export const makeDispatcher = (deps: {
  readonly runs: TaskRuns
  readonly org: Pick<Org, 'jobTitles' | 'hiredAgents' | 'settings'>
  readonly projectDirectory: ProjectDirectory
}) =>
  Effect.gen(function* () {
    const { runs, org, projectDirectory } = deps
    const pluginScope = yield* Effect.scope
    const tasks = yield* SynchronizedRef.make(new Map<TaskId, LiveTask>())
    const backendRef = yield* Ref.make(Option.none<AgentBackend>())
    const models = yield* Ref.make(Option.none<readonly [ModelOption, ...Array<ModelOption>]>())
    const failed = yield* Ref.make(new Set<TaskId>())
    const answerOrder = yield* Ref.make(0)
    const signals = yield* Queue.sliding<void>(1)

    const changes = yield* PubSub.unbounded<void>()

    const signal = Queue.offer(signals, undefined).pipe(Effect.asVoid)

    const updateTasks = <A>(
      f: (current: Map<TaskId, LiveTask>) => readonly [A, Map<TaskId, LiveTask> | undefined]
    ) =>
      SynchronizedRef.modify(tasks, (current) => {
        const [result, next] = f(current)
        return [[result, next !== undefined] as const, next ?? current] as const
      }).pipe(
        Effect.flatMap(([result, changed]) =>
          changed
            ? PubSub.publish(changes, undefined).pipe(Effect.as(result))
            : Effect.succeed(result)
        )
      )

    const closeLive = (live: LiveTask) =>
      Effect.gen(function* () {
        if (Option.isSome(live.watcher)) yield* Fiber.interrupt(live.watcher.value)
        if (Option.isSome(live.scope)) yield* Scope.close(live.scope.value, Exit.void)
      })

    const drop = (taskId: TaskId) =>
      updateTasks((current) => {
        const live = current.get(taskId)
        if (live === undefined) return [undefined, undefined] as const
        const next = new Map(current)
        next.delete(taskId)
        return [live, next] as const
      })

    const onEvent = (taskId: TaskId) => (message: OutboundMessage) =>
      Effect.gen(function* () {
        if (message._tag === 'SessionStarted') {
          yield* runs.markSessionStarted(taskId, message.sessionId)
          return
        }
        const freed = yield* updateTasks((current) => {
          const live = current.get(taskId)
          if (live === undefined) return [false, undefined] as const
          const changed = applyEvent(live, taskId, message)
          if (changed === live) return [false, undefined] as const
          const next = new Map(current)
          next.set(taskId, changed)
          return [holdsSlot(live) && !holdsSlot(changed), next] as const
        })
        if (freed) {
          yield* Effect.logDebug('Hired agent freed its slot', { taskId, event: message._tag })
          yield* signal
        }
      })

    const onEnded = (taskId: TaskId, end: SessionEnd) =>
      Effect.gen(function* () {
        const keepSession = end._tag !== 'SessionNotFound'
        if (end._tag === 'SessionFailed') {
          yield* Ref.update(failed, (current) => new Set(current).add(taskId))
        }
        yield* Effect.logWarning('Hired agent session ended', { taskId, end: end._tag })
        yield* runs.markRequeued(taskId, keepSession)
        const live = yield* drop(taskId)
        if (live !== undefined && Option.isSome(live.scope)) {
          yield* Scope.close(live.scope.value, Exit.void)
        }
        yield* signal
      })

    const startTask = Effect.fnUntraced(function* (
      backend: AgentBackend,
      catalog: readonly [ModelOption, ...Array<ModelOption>],
      context: StartContext
    ) {
      const { task, objective, hire, jobTitle, directory } = context
      const unreserve = drop(task.id).pipe(Effect.andThen(signal))
      if (!(yield* runs.markStarted(task.id, hire.id))) {
        yield* Effect.logInfo('Task changed before it started', { taskId: task.id })
        return yield* unreserve
      }
      const model = jobTitle.model ?? catalog[0].value
      const disabled = yield* backend.disabledPermissionModes(directory)
      const input = {
        modelSupportsAuto: catalog.find((option) => option.value === model)?.autoMode ?? false,
        disabled,
        bypassOptedIn: hire.bypassOverride ?? jobTitle.bypassOptIn
      }
      const permissionMode = startPermissionMode(input)
      yield* Effect.logInfo('Starting hired agent session', {
        taskId: task.id,
        hireId: hire.id,
        model,
        ...input,
        permissionMode
      })
      const scope = yield* Scope.make()
      const session = yield* backend
        .openSession({
          config: {
            paneId: task.paneId,
            cwd: directory,
            model,
            thinkingLevel: jobTitle.thinkingLevel,
            permissionMode
          },
          resume: Option.fromNullishOr(task.sessionId),
          emit: onEvent(task.id),
          systemPromptAppend: jobTitle.jobDescription,
          pluginPaths: [],
          diaTools: [],
          tools: Option.some({
            permissions: jobTitle.permissions,
            mcpServers: jobTitle.mcpServers
          })
        })
        .pipe(Scope.provide(scope))
      const watcher = yield* session.ended.pipe(
        Effect.flatMap((end) => onEnded(task.id, end)),
        Effect.forkIn(pluginScope)
      )
      const kept = yield* updateTasks((current) => {
        const live = current.get(task.id)
        if (live === undefined) return [false, undefined] as const
        const next = new Map(current)
        next.set(task.id, {
          ...live,
          scope: Option.some(scope),
          session: Option.some(session),
          watcher: Option.some(watcher)
        })
        return [true, next] as const
      })
      if (!kept) {
        yield* Fiber.interrupt(watcher)
        yield* Scope.close(scope, Exit.void)
        yield* runs.markRequeued(task.id, true)
        return yield* signal
      }
      yield* session.sendText(promptFor(task, objective), 'queue')
    })

    const resumeTask = Effect.fnUntraced(function* (taskId: TaskId) {
      const answers = yield* updateTasks((current) => {
        const live = current.get(taskId)
        if (live === undefined) return [undefined, undefined] as const
        const next = new Map(current)
        next.set(taskId, {
          ...live,
          queued: [],
          turn: live.pending.size > 0 ? 'awaiting-user' : 'running'
        })
        return [{ session: live.session, queued: live.queued }, next] as const
      })
      if (answers === undefined || Option.isNone(answers.session)) return
      const session = answers.session.value
      yield* Effect.logInfo('Resuming hired agent after an answer', {
        taskId,
        answers: answers.queued.length
      })
      for (const answer of answers.queued) {
        yield* session.resolvePermission(answer.requestId, answer.response)
      }
    })

    const contextsFor = Effect.fnUntraced(function* (waiting: ReadonlyArray<WaitingTask>) {
      const hires = new Map((yield* org.hiredAgents).map((hire) => [hire.id, hire]))
      const jobTitles = new Map((yield* org.jobTitles).map((jobTitle) => [jobTitle.id, jobTitle]))
      const skipped = yield* Ref.get(failed)
      const contexts = new Map<TaskId, StartContext>()
      for (const { task, objective } of waiting) {
        const hire = task.assignee === null ? undefined : hires.get(task.assignee)
        const jobTitle = hire === undefined ? undefined : jobTitles.get(hire.jobTitleId)
        if (hire === undefined || jobTitle === undefined || skipped.has(task.id)) continue
        const directory = yield* projectDirectory(objective)
        if (Option.isNone(directory)) {
          yield* Effect.logWarning('Skipped a task whose project is not registered', {
            taskId: task.id,
            projectId: objective.projectId
          })
          continue
        }
        contexts.set(task.id, { task, objective, hire, jobTitle, directory: directory.value })
      }
      return contexts
    })

    const pass = Effect.gen(function* () {
      const backend = yield* Ref.get(backendRef)
      const catalog = yield* Ref.get(models)
      const { overallCap } = yield* org.settings
      const candidates = yield* runs.startCandidates
      const contexts =
        Option.isSome(backend) && Option.isSome(catalog)
          ? yield* contextsFor(candidates.waiting)
          : new Map<TaskId, StartContext>()
      const pick = yield* updateTasks((current) => {
        const entries = [...current.entries()]
        const answered = entries
          .filter(([, live]) => live.queued.length > 0)
          .sort(
            ([, left], [, right]) => (left.queued[0]?.order ?? 0) - (right.queued[0]?.order ?? 0)
          )
          .map(([taskId]) => taskId)
        const chosen = nextStarts({
          overallCap,
          heldSlots: entries.filter(([, live]) => holdsSlot(live)).length,
          busyHires: candidates.busyHires,
          answered,
          waiting: [...contexts.values()]
            .filter(({ task }) => !current.has(task.id))
            .map(({ task, hire, objective }) => ({
              taskId: task.id,
              hireId: hire.id,
              priority: objective.priority,
              createdAt: task.createdAt
            }))
        })
        if (chosen.start.length === 0) return [chosen, undefined] as const
        const next = new Map(current)
        for (const taskId of chosen.start) next.set(taskId, reserved)
        return [chosen, next] as const
      })
      yield* Effect.logDebug('Scheduling pass', {
        overallCap,
        waiting: contexts.size,
        resume: pick.resume,
        start: pick.start
      })
      for (const taskId of pick.resume) yield* resumeTask(taskId)
      if (Option.isNone(backend) || Option.isNone(catalog)) return
      for (const taskId of pick.start) {
        const context = contexts.get(taskId)
        if (context !== undefined) yield* startTask(backend.value, catalog.value, context)
      }
    })

    const lendBackend = (backend: AgentBackend) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Ref.set(backendRef, Option.some(backend)), () =>
          Ref.set(backendRef, Option.none()).pipe(Effect.andThen(Ref.set(models, Option.none())))
        )
        yield* Ref.set(failed, new Set())
        yield* backend.models().pipe(
          Stream.runForEach((state) =>
            state._tag === 'Ready'
              ? Ref.set(models, Option.some(state.models)).pipe(
                  Effect.andThen(Ref.set(failed, new Set())),
                  Effect.andThen(signal)
                )
              : Effect.void
          ),
          Effect.forkScoped
        )
        yield* Effect.logInfo('Dispatcher uses the agent backend')
        yield* signal
      })

    const answerPermission = Effect.fn('Dispatcher.answerPermission')(function* (
      taskId: TaskId,
      requestId: string,
      response: PermissionResponse
    ) {
      const order = yield* Ref.getAndUpdate(answerOrder, (n) => n + 1)
      const outcome = yield* updateTasks((current) => {
        const live = current.get(taskId)
        if (live === undefined) return ['not-pending' as const, undefined] as const
        if (live.answeredIds.has(requestId)) return ['repeated' as const, undefined] as const
        if (!live.pending.has(requestId)) return ['not-pending' as const, undefined] as const
        const pending = new Map(live.pending)
        pending.delete(requestId)
        const next = new Map(current)
        next.set(taskId, {
          ...live,
          pending,
          queued: [...live.queued, { requestId, response, order }],
          answeredIds: new Set(live.answeredIds).add(requestId)
        })
        return ['queued' as const, next] as const
      })
      if (outcome === 'not-pending') {
        return yield* PermissionNotPending.make({ taskId, requestId })
      }
      yield* Effect.logInfo('Queued a permission answer', { taskId, requestId, outcome })
      yield* signal
    })

    const release = Effect.fn('Dispatcher.release')(function* (taskId: TaskId) {
      yield* Ref.update(failed, (current) => {
        const next = new Set(current)
        next.delete(taskId)
        return next
      })
      const live = yield* drop(taskId)
      if (live !== undefined) {
        yield* closeLive(live)
        yield* Effect.logInfo('Released hired agent session', { taskId })
      }
      yield* signal
    })

    const live = Effect.map(SynchronizedRef.get(tasks), (current) =>
      LiveWork.make({
        pendingPermissions: [...current.values()].flatMap((entry) => [...entry.pending.values()]),
        heldSlots: [...current.values()].filter(holdsSlot).length
      })
    )

    yield* runs.requeueRunning
    yield* Effect.addFinalizer(() =>
      SynchronizedRef.get(tasks).pipe(
        Effect.flatMap((current) => Effect.forEach(current.values(), closeLive, { discard: true }))
      )
    )
    yield* Queue.take(signals).pipe(
      Effect.andThen(pass),
      Effect.catchCause((cause) => Effect.logError('Scheduling pass failed', cause)),
      Effect.forever,
      Effect.forkScoped
    )

    const watchChanges = Effect.map(PubSub.subscribe(changes), Stream.fromSubscription)

    return {
      signal,
      lendBackend,
      answerPermission,
      release,
      live,
      watchChanges
    } satisfies Dispatcher
  })
