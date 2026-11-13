import {
  type Attachment,
  Attention,
  EMPTY_MESSAGE_QUEUE,
  type GitOps,
  type PaneConfig,
  PaneEvents,
  type Parking,
  type PermissionMode,
  type RunAnswer,
  type RunChange,
  type RunEvents,
  RunNotFoundError,
  RunPermissionModeChanged,
  type RunRequest,
  RunSessionChanged,
  type RunSpec,
  type Runs,
  RunTabRequested,
  type SendMode,
  type SessionAdditions,
  type SessionId,
  type StartRunOptions,
  type ThinkingLevel,
  type WorktreeCreateError,
  type WorktreeInfo,
  WorktreeReattachError
} from '@dia/plugin'
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef
} from 'effect'
import type { AgentBackend, SessionEnd } from './backend'
import { type LiveRunHandle, startLiveRun } from './live-run'
import { cwdOf, type RunRow, type RunRows, type StoredSpec } from './run-rows'
import type { RunTools } from './run-tools'
import { setUpWorktreeTab } from './tab-setup'

const SESSION_NOT_FOUND_NOTICE =
  "This tab's conversation could not be found. Send your message again to start a new conversation."
const INTERRUPTED_NOTICE = 'The turn was interrupted before it started. Send your message again.'
const WORKTREES_NOT_LOADED = 'Load the worktrees plugin to resume this run'
const APPEND_RETRIES = 3

const isPaneSignal = Schema.is(PaneEvents.PaneSignal)

/** What {@link makeRunRegistry} reads at the time of each use, so a reload of a provider applies. */
export interface RunRegistryDeps {
  readonly rows: RunRows
  readonly backend: Effect.Effect<AgentBackend>
  readonly runEvents: Effect.Effect<Option.Option<RunEvents>>
  readonly gitOps: Effect.Effect<Option.Option<GitOps>>
  readonly additions: Effect.Effect<SessionAdditions>
  readonly sessionTools: RunTools['sessionTools']
  readonly usageLimitResume: Effect.Effect<Parking.UsageLimitResume>
  readonly newRunId: Effect.Effect<string>
}

interface RunEntry {
  readonly config: PaneConfig
  readonly handle: LiveRunHandle
  readonly repark: (mode: Parking.UsageLimitResume) => Effect.Effect<void>
  readonly idle: Effect.Effect<void>
  readonly stop: Effect.Effect<boolean>
  readonly scope: Scope.Closeable
  readonly endOutbound: Effect.Effect<unknown>
  readonly subscriber: Fiber.Fiber<void>
  readonly closed: Deferred.Deferred<void>
}

interface RunActivity {
  readonly running: boolean
  readonly backgroundTasks: number
}

const IDLE: RunActivity = { running: false, backgroundTasks: 0 }

const isBusy = (activity: RunActivity) => activity.running || activity.backgroundTasks > 0

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((id, index) => id === right[index])

const specOfRow = (row: RunRow): RunSpec => ({
  runId: row.runId,
  sourceCwd: row.spec.sourceCwd,
  model: row.spec.model,
  thinkingLevel: row.spec.thinkingLevel,
  permissionMode: row.spec.permissionMode,
  worktree: row.spec.worktree === null ? undefined : { _tag: 'Reattach', info: row.spec.worktree },
  resume: row.sessionId,
  ...(row.spec.labels === undefined ? {} : { labels: row.spec.labels }),
  ...(row.spec.context === undefined ? {} : { context: row.spec.context })
})

/**
 * Builds the run service `dia-runs` provides (`runs`), the recovery it runs once it has provided
 * it (`recover`: resumes each run whose row says a turn was in progress, leaving alone a run that
 * is already live, such as one started since the service was provided), and
 * `setUsageLimitResume`, which re-parks every parked run under a new mode. Every live run lives in
 * a scope of its own; closing the calling scope ends them all without changing their rows, so a
 * later start resumes their turns.
 */
export const makeRunRegistry = Effect.fn('RunRegistry.make')(function* (deps: RunRegistryDeps) {
  const { rows } = deps
  const entriesRef = yield* Ref.make<ReadonlyMap<string, RunEntry>>(new Map())
  const requestsRef = yield* SubscriptionRef.make<ReadonlyMap<string, Attention.UserInputRequest>>(
    new Map()
  )
  const activityRef = yield* SubscriptionRef.make<ReadonlyMap<string, RunActivity>>(new Map())
  const changes = yield* PubSub.unbounded<RunChange>()
  const openLock = yield* Semaphore.make(1)

  const appendSignal = Effect.fnUntraced(function* (runId: string, event: PaneEvents.IpcEvent) {
    if (!isPaneSignal(event)) {
      return yield* Effect.logWarning('Dropped a run event that is not a pane signal', {
        runId,
        event: event._tag
      })
    }
    const provided = yield* deps.runEvents
    if (Option.isNone(provided)) {
      return yield* Effect.logWarning('No run event log; a run event was not stored', {
        runId,
        event: event._tag
      })
    }
    yield* provided.value.append(runId, [{ event }]).pipe(
      Effect.retry({ times: APPEND_RETRIES, schedule: Schedule.exponential(Duration.millis(20)) }),
      Effect.catch((cause) =>
        Effect.logError('Could not store a run event', { runId, event: event._tag, cause })
      )
    )
  })

  const setRequest = (runId: string, request: Option.Option<Attention.UserInputRequest>) =>
    SubscriptionRef.update(requestsRef, (current) => {
      const next = new Map(current)
      if (Option.isSome(request)) next.set(runId, request.value)
      else next.delete(runId)
      return next
    })

  const setActivity = (runId: string, change: Partial<RunActivity>) =>
    SubscriptionRef.update(activityRef, (current) =>
      new Map(current).set(runId, { ...(current.get(runId) ?? IDLE), ...change })
    )

  const dropActivity = (runId: string) =>
    SubscriptionRef.update(activityRef, (current) => {
      const next = new Map(current)
      next.delete(runId)
      return next
    })

  const teardown = Effect.fn('RunRegistry.teardown')(function* (runId: string) {
    const entry = yield* Ref.modify(entriesRef, (current) => {
      const found = current.get(runId)
      if (found === undefined) return [undefined, current]
      const next = new Map(current)
      next.delete(runId)
      return [found, next]
    })
    if (entry === undefined) return
    yield* entry.stop
    yield* Deferred.succeed(entry.closed, undefined)
    yield* setRequest(runId, Option.none())
    yield* dropActivity(runId)
    yield* Effect.logInfo('Closing a run', { runId })
    yield* entry.endOutbound
    yield* Fiber.join(entry.subscriber)
    yield* Scope.close(entry.scope, Exit.void)
  })

  const releaseWorktree = (gitOps: GitOps, runId: string) => (info: WorktreeInfo) =>
    gitOps.releaseWorktree(info, runId).pipe(
      Effect.flatMap((outcome) =>
        Effect.logInfo('Released the run worktree', { runId, path: info.path, outcome })
      ),
      Effect.catchCause((cause) =>
        Effect.logError('Failed to remove the run worktree', { runId, cause })
      )
    )

  const provision = Effect.fn('RunRegistry.provision')(function* (spec: RunSpec) {
    const projectConfig: PaneConfig = {
      paneId: spec.runId,
      cwd: spec.sourceCwd,
      model: spec.model,
      thinkingLevel: spec.thinkingLevel,
      permissionMode: spec.permissionMode
    }
    const request = spec.worktree
    if (request === undefined) return { config: projectConfig, setup: undefined }
    const gitOps = yield* deps.gitOps
    if (Option.isNone(gitOps)) {
      if (request._tag === 'Reattach') {
        return yield* new WorktreeReattachError({
          paneId: spec.runId,
          path: request.info.path,
          cause: WORKTREES_NOT_LOADED
        })
      }
      yield* Effect.logWarning(
        'Opening the run in the project directory because the worktrees plugin is not loaded',
        { runId: spec.runId, cwd: spec.sourceCwd }
      )
      return { config: projectConfig, setup: undefined }
    }
    const acquire: Effect.Effect<WorktreeInfo, WorktreeCreateError | WorktreeReattachError> =
      request._tag === 'Create'
        ? gitOps.value.createWorktree(
            spec.sourceCwd,
            { paneId: spec.runId, label: request.label },
            Option.none()
          )
        : gitOps.value.reattachWorktree(request.info, spec.runId)
    const setup = yield* setUpWorktreeTab({
      paneId: spec.runId,
      sourceRepo: spec.sourceCwd,
      reattach: request._tag === 'Reattach',
      gitOps: gitOps.value,
      acquire: Effect.acquireRelease(acquire, releaseWorktree(gitOps.value, spec.runId)),
      emit: (event) => appendSignal(spec.runId, event)
    })
    const config: PaneConfig = {
      ...projectConfig,
      cwd: setup.worktree.path,
      worktree: setup.worktree
    }
    return { config, setup }
  })

  const storedSpec = (spec: RunSpec, config: PaneConfig): StoredSpec => ({
    sourceCwd: spec.sourceCwd,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    permissionMode: config.permissionMode,
    worktree: config.worktree ?? null,
    ...(spec.labels === undefined ? {} : { labels: spec.labels }),
    ...(spec.context === undefined ? {} : { context: spec.context })
  })

  const recordFor = Effect.fnUntraced(function* (
    config: PaneConfig,
    resume: Option.Option<SessionId>
  ) {
    const provided = yield* deps.runEvents
    if (Option.isNone(provided)) {
      yield* Effect.logError('No run event log; the run is not recorded', { runId: config.paneId })
      return () => Effect.void
    }
    yield* provided.value.seed(config.paneId)
    return yield* provided.value.record({ runId: config.paneId, cwd: config.cwd, resume })
  })

  const openRun = Effect.fn('RunRegistry.openRun')(function* (spec: RunSpec, hasTab: boolean) {
    const existing = (yield* Ref.get(entriesRef)).get(spec.runId)
    if (existing !== undefined) {
      if (hasTab) yield* rows.setHasTab(spec.runId)
      return existing.config
    }
    const prior = yield* rows.get(spec.runId)
    const scope = yield* Scope.make()
    const prepared = yield* provision(spec).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.result
    )
    if (Result.isFailure(prepared)) {
      yield* Scope.close(scope, Exit.fail(prepared.failure))
      return yield* prepared.failure
    }
    const { config, setup } = prepared.success
    yield* rows.upsert(spec.runId, storedSpec(spec, config), spec.resume, hasTab)
    const runId = spec.runId

    const start = Effect.gen(function* () {
      const record = yield* recordFor(config, spec.resume)
      return yield* startLiveRun({
        config,
        resume: spec.resume,
        record,
        usageLimitResume: deps.usageLimitResume,
        onStatus: (status) =>
          Effect.andThen(
            setActivity(runId, { running: status === 'running' }),
            rows.setStatus(runId, status)
          ),
        onBackgroundTasks: (backgroundTasks) => setActivity(runId, { backgroundTasks }),
        onSessionChanged: (sessionId) =>
          rows
            .setSessionId(runId, sessionId)
            .pipe(
              Effect.andThen(
                PubSub.publish(
                  changes,
                  RunSessionChanged.make({ runId, sessionId: Option.getOrNull(sessionId) })
                )
              )
            ),
        onPermissionModeChanged: (mode) =>
          Effect.gen(function* () {
            const row = yield* rows.get(runId)
            if (Option.isSome(row)) {
              yield* rows.setSpec(runId, { ...row.value.spec, permissionMode: mode })
            }
            yield* PubSub.publish(changes, RunPermissionModeChanged.make({ runId, mode }))
          }),
        open: (emit) =>
          Effect.gen(function* () {
            const backend = yield* deps.backend
            const additions = yield* deps.additions
            const tools = yield* deps.sessionTools({
              runId,
              project: spec.sourceCwd,
              labels: spec.labels ?? [],
              context: spec.context
            })
            return yield* backend.openSession({
              config,
              resume: spec.resume,
              emit,
              ...additions,
              tools
            })
          })
      })
    }).pipe(Effect.provideService(Scope.Scope, scope))
    const started = yield* setup === undefined ? start : setup.startSession(start)

    const subscriber = yield* Effect.forkDetach(
      started.drain((event) => appendSignal(runId, event))
    )
    yield* started.request.pipe(
      Stream.runForEach((request) => setRequest(runId, request)),
      Effect.forkIn(scope)
    )
    const closed = yield* Deferred.make<void>()
    const entry: RunEntry = {
      config,
      handle: started.handle,
      repark: started.repark,
      idle: started.idle,
      stop: started.stop,
      scope,
      endOutbound: Queue.end(started.outbound),
      subscriber,
      closed
    }
    yield* Ref.update(entriesRef, (current) => new Map(current).set(runId, entry))

    const ended = Effect.fnUntraced(function* (end: SessionEnd) {
      if (end._tag === 'SessionNotFound') {
        yield* Effect.logWarning('Run session not found; cleared the run session', {
          runId,
          sessionId: end.sessionId
        })
        yield* rows.setSessionId(runId, Option.none())
        yield* PubSub.publish(changes, RunSessionChanged.make({ runId, sessionId: null }))
        yield* started.publish(
          PaneEvents.PaneMessageQueueChanged.make({ paneId: runId, ...EMPTY_MESSAGE_QUEUE })
        )
        yield* started.handle.markErrored({ message: SESSION_NOT_FOUND_NOTICE })
        if (setup !== undefined) yield* setup.failSession(SESSION_NOT_FOUND_NOTICE)
      } else {
        yield* Effect.logError('A run session ended unexpectedly', { runId, reason: end.reason })
        yield* started.handle.markCrashed({
          message: `Pane session ended unexpectedly: ${end.reason}`
        })
      }
      yield* rows.setStatus(runId, 'idle')
      yield* teardown(runId)
    })

    yield* started.session.ended.pipe(
      Effect.map(Option.some),
      Effect.raceFirst(Deferred.await(closed).pipe(Effect.as(Option.none<SessionEnd>()))),
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: ended })),
      Effect.forkDetach
    )

    if (Option.isSome(prior) && prior.value.status === 'running') {
      if (Option.isSome(spec.resume)) {
        yield* setActivity(runId, { running: true })
        yield* started.handle.continueTurn
      } else yield* interruptedBeforeStart(runId)
    }
    return config
  })

  const interruptedBeforeStart = Effect.fnUntraced(function* (runId: string) {
    yield* Effect.logWarning('A turn was cut off before its session started', { runId })
    yield* rows.setStatus(runId, 'idle')
    yield* appendSignal(
      runId,
      PaneEvents.PaneAttentionChanged.make({
        paneId: runId,
        attention: Attention.Errored.make({ error: { message: INTERRUPTED_NOTICE } })
      })
    )
  })

  const open = (spec: RunSpec, hasTab: boolean) => openLock.withPermits(1)(openRun(spec, hasTab))

  const live = (runId: string) => Effect.map(Ref.get(entriesRef), (entries) => entries.get(runId))

  const ensureLive = Effect.fn('RunRegistry.ensureLive')(function* (runId: string) {
    const entry = yield* live(runId)
    if (entry !== undefined) return Option.some(entry)
    const row = yield* rows.get(runId)
    if (Option.isNone(row) || row.value.status === 'archived') {
      yield* Effect.logWarning('No run to open for a command', {
        runId,
        archived: Option.isSome(row)
      })
      return Option.none<RunEntry>()
    }
    const opened = yield* open(specOfRow(row.value), row.value.hasTab).pipe(Effect.result)
    if (Result.isFailure(opened)) {
      yield* Effect.logError('Failed to open a run', { runId, cause: opened.failure })
      yield* appendSignal(
        runId,
        PaneEvents.PaneAttentionChanged.make({
          paneId: runId,
          attention: Attention.Errored.make({
            error: { message: `Failed to resume pane: ${String(opened.failure)}` }
          })
        })
      )
      return Option.none<RunEntry>()
    }
    return Option.fromUndefinedOr(yield* live(runId))
  })

  const withLive =
    (command: string, opening: boolean) =>
    (runId: string, op: (handle: LiveRunHandle) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        const entry = opening
          ? yield* ensureLive(runId)
          : Option.fromUndefinedOr(yield* live(runId))
        if (Option.isNone(entry)) {
          return yield* Effect.logWarning(`Dropped ${command} for a run that is not live`, {
            runId
          })
        }
        yield* op(entry.value.handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`Failed to apply ${command}`, { runId, cause })
          )
        )
      })

  const updateSpec = (runId: string, patch: Partial<StoredSpec>) =>
    Effect.flatMap(rows.get(runId), (row) =>
      Option.isSome(row) ? rows.setSpec(runId, { ...row.value.spec, ...patch }) : Effect.void
    )

  const answer = (runId: string, requestId: string, given: RunAnswer) =>
    withLive('answer', false)(runId, (handle) => {
      switch (given._tag) {
        case 'PermissionAnswer':
          return handle.resolvePermission(requestId, given.response)
        case 'QuestionAnswer':
          return handle.resolveQuestion(requestId, given.response)
        case 'PlanReviewAnswer':
          return handle.resolvePlanReview(requestId, given.approved)
      }
    })

  const start = Effect.fn('RunRegistry.start')(function* (options: StartRunOptions) {
    const runId = yield* deps.newRunId
    yield* open(
      {
        runId,
        sourceCwd: options.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        permissionMode: options.permissionMode,
        worktree: undefined,
        resume: Option.none(),
        ...(options.labels === undefined ? {} : { labels: options.labels }),
        ...(options.context === undefined ? {} : { context: options.context })
      },
      false
    ).pipe(Effect.orDie)
    yield* withLive('start', false)(runId, (handle) =>
      setActivity(runId, { running: true }).pipe(
        Effect.andThen(handle.sendMessage(options.text, 'queue')),
        Effect.onError(() => setActivity(runId, { running: false }))
      )
    )
    yield* Effect.logInfo('Started a run with no tab', { runId, cwd: options.cwd })
    return runId
  })

  const openInTab = Effect.fn('RunRegistry.openInTab')(function* (runId: string) {
    const row = yield* rows.get(runId)
    if (Option.isNone(row)) return yield* new RunNotFoundError({ runId })
    yield* rows.setHasTab(runId)
    yield* PubSub.publish(
      changes,
      RunTabRequested.make({
        runId,
        directory: row.value.spec.sourceCwd,
        model: row.value.spec.model,
        thinkingLevel: row.value.spec.thinkingLevel,
        permissionMode: row.value.spec.permissionMode,
        sessionId: Option.getOrNull(row.value.sessionId)
      })
    )
    yield* Effect.logInfo('Asked for a tab for a run', { runId })
  })

  const closeAll = Effect.flatMap(Ref.get(entriesRef), (entries) =>
    Effect.forEach([...entries.keys()], teardown, { discard: true })
  )
  yield* Effect.addFinalizer(() => closeAll)

  const runs: Runs = {
    open: (spec) => open(spec, true),
    start,
    send: (runId: string, text: string, mode: SendMode, attachments?: ReadonlyArray<Attachment>) =>
      withLive('send', true)(runId, (handle) => handle.sendMessage(text, mode, attachments)),
    editQueued: (runId, messageId, text, attachments) =>
      withLive('editQueued', false)(runId, (handle) =>
        handle.editQueuedMessage(messageId, text, attachments)
      ),
    removeQueued: (runId, messageId) =>
      withLive('removeQueued', false)(runId, (handle) => handle.removeQueuedMessage(messageId)),
    sendQueuedNow: (runId, messageId) =>
      withLive('sendQueuedNow', false)(runId, (handle) => handle.sendQueuedMessageNow(messageId)),
    answer,
    requests: SubscriptionRef.changes(requestsRef).pipe(
      Stream.map((current) =>
        [...current].map(([runId, request]): RunRequest => ({ runId, request }))
      )
    ),
    interrupt: (runId) => withLive('interrupt', false)(runId, (handle) => handle.interrupt()),
    resumeParked: (runId) =>
      withLive('resumeParked', false)(runId, (handle) => handle.resumeParked),
    rewind: (runId, messageUuid, resumeAnchorUuid) =>
      withLive('rewind', true)(runId, (handle) =>
        handle.rewindToCheckpoint(messageUuid, resumeAnchorUuid)
      ),
    setThinkingLevel: (runId: string, level: ThinkingLevel) =>
      updateSpec(runId, { thinkingLevel: level }).pipe(
        Effect.andThen(withLive('setThinkingLevel', false)(runId, (h) => h.setThinkingLevel(level)))
      ),
    setPermissionMode: (runId: string, mode: PermissionMode) =>
      updateSpec(runId, { permissionMode: mode }).pipe(
        Effect.andThen(
          withLive('setPermissionMode', false)(runId, (h) => h.setPermissionMode(mode))
        )
      ),
    setModel: (runId: string, model: string) =>
      updateSpec(runId, { model }).pipe(
        Effect.andThen(withLive('setModel', false)(runId, (h) => h.setModel(model)))
      ),
    awaitIdle: (runId) =>
      Effect.flatMap(live(runId), (entry) => (entry === undefined ? Effect.void : entry.idle)),
    isLive: (runId) => Effect.map(live(runId), (entry) => entry !== undefined),
    close: (runId) => openLock.withPermits(1)(teardown(runId)),
    retire: (runId, as) =>
      openLock
        .withPermits(1)(teardown(runId))
        .pipe(
          Effect.andThen(
            as === 'archived' ? rows.setStatus(runId, 'archived') : rows.remove(runId)
          ),
          Effect.andThen(Effect.logInfo('Retired a run', { runId, as }))
        ),
    list: Effect.gen(function* () {
      const entries = yield* Ref.get(entriesRef)
      return (yield* rows.list).map((row) => ({
        runId: row.runId,
        cwd: cwdOf(row.spec),
        model: row.spec.model,
        thinkingLevel: row.spec.thinkingLevel,
        permissionMode: row.spec.permissionMode,
        sessionId: row.sessionId,
        status: row.status,
        live: entries.has(row.runId)
      }))
    }),
    openInTab,
    busy: SubscriptionRef.changes(activityRef).pipe(
      Stream.map((current) =>
        [...current]
          .filter(([, activity]) => isBusy(activity))
          .map(([runId]) => runId)
          .sort()
      ),
      Stream.changesWith(sameIds)
    ),
    changes: Stream.fromPubSub(changes),
    discoverSessions: (directory) =>
      Effect.flatMap(deps.backend, (backend) =>
        backend.discoverSessions === undefined
          ? Effect.logDebug('The agent backend cannot discover sessions', { directory }).pipe(
              Effect.as([])
            )
          : backend.discoverSessions(directory)
      )
  }

  const recover = Effect.gen(function* () {
    const entries = yield* Ref.get(entriesRef)
    const stored = (yield* rows.list).filter((row) => !entries.has(row.runId))
    yield* Effect.forEach(
      stored.filter((row) => row.status === 'waiting'),
      (row) => rows.setStatus(row.runId, 'idle'),
      { discard: true }
    )
    const inProgress = stored.filter((row) => row.status === 'running')
    yield* Effect.logInfo('Recovering runs whose turn was in progress', {
      runs: inProgress.map((row) => row.runId)
    })
    yield* Effect.forEach(
      inProgress,
      (row) =>
        Option.isNone(row.sessionId)
          ? interruptedBeforeStart(row.runId)
          : ensureLive(row.runId).pipe(Effect.asVoid),
      { discard: true }
    )
  })

  const setUsageLimitResume = Effect.fn('RunRegistry.setUsageLimitResume')(function* (
    mode: Parking.UsageLimitResume
  ) {
    const entries = yield* Ref.get(entriesRef)
    yield* Effect.forEach(entries.values(), (entry) => entry.repark(mode), { discard: true })
  })

  return { runs, recover, setUsageLimitResume }
})
