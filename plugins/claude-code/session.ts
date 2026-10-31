import {
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKMessage,
  type SDKStartupFailureReason,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  type AgentSession,
  type AgentSessionOptions,
  type DiaTool,
  MessageQueueChanged,
  ModelChanged,
  makePendingUserInput,
  type OutboundMessage,
  type PendingUserInput,
  PermissionModeChanged,
  PermissionRequested,
  PlanReviewRequested,
  PlanReviewResponse,
  Question,
  QuestionRequested,
  RESUME_TEXT,
  RewoundToCheckpoint,
  type SessionEnd,
  SessionFailed,
  SessionNotFound,
  SlashCommandsAvailable,
  SlashCommandsWarming,
  TurnCompleted,
  type UserInputResolution,
  UserMessagesSent
} from '@dia/plugin'
import type { QuestionResponse } from '@shared/domain/attention'
import type { OutgoingMessage, SendMode } from '@shared/domain/message-queue'
import type { PaneConfig, SessionId, ThinkingLevel } from '@shared/domain/pane'
import {
  Cause,
  Clock,
  type Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Match,
  Option,
  Predicate,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream
} from 'effect'
import {
  type ClaudeInstall,
  installQueryOptions,
  NOT_INSTALLED_REASON,
  overrideUnrunnableReason
} from './claude-install'
import {
  dispatchEnded,
  edit,
  initialQueueState,
  type QueueAction,
  type QueueState,
  type QueueTransition,
  remove,
  resume as resumeQueue,
  rewound,
  send,
  sessionEnded,
  snapshotOf,
  stopRequested,
  turnEnded
} from './message-queue'
import {
  makePermissionModeController,
  type PermissionModeController
} from './permission-mode-controller'
import { makeSessionEventReducer } from './reducer'
import { thinkingOptions } from './thinking-options'
import { DIA_TOOL_SERVER_KEY, isDiaToolName, makeDiaToolServer } from './tool-server'
import { readLastAssistantUuid, readTurnResumeAnchor } from './transcript'

/**
 * Wraps a failure surfaced while consuming the Agent SDK's event stream
 * (e.g. the underlying async iterable throwing). Raised by the `events`
 * stream in `runSession`; handle it via the surrounding Effect's error
 * channel rather than a try/catch.
 */
export class SessionStreamError extends Data.TaggedError('SessionStreamError')<{
  readonly cause: unknown
}> {}

const decodeQuestions = Schema.decodeUnknownResult(Schema.Array(Question))

const joinAnswer = (answer: string | ReadonlyArray<string>): string =>
  typeof answer === 'string' ? answer : answer.join(', ')

/**
 * Maps a user's `QuestionResponse` to the `PermissionResult` the SDK's
 * `AskUserQuestion` tool receives: the questions plus comma-joined answers, and
 * an optional freeform response, mirroring the SDK's `AskUserQuestionOutput`.
 */
const questionResponseToResult = (response: QuestionResponse): PermissionResult => {
  const answers =
    response._tag === 'Answers'
      ? Object.fromEntries(
          Object.entries(response.answers).map(([question, answer]) => [
            question,
            joinAnswer(answer)
          ])
        )
      : {}
  return {
    behavior: 'allow',
    updatedInput: {
      questions: response.questions,
      answers,
      ...(response._tag === 'FreeformResponse' ? { response: response.response } : {})
    }
  }
}

/**
 * Maps a resolved `UserInputResolution` to the SDK `PermissionResult`. For an
 * `Allow`, `updatedInput` is forwarded only when the user edited it, and the
 * retained SDK `suggestions` are echoed back as `updatedPermissions` when the
 * user asked to remember this kind of call.
 */
const toPermissionResult = (
  resolution: UserInputResolution,
  suggestions: PermissionUpdate[] | undefined
): PermissionResult =>
  Match.value(resolution).pipe(
    Match.tag('Deny', (r): PermissionResult => ({ behavior: 'deny', message: r.message })),
    Match.tag(
      'Allow',
      (r): PermissionResult => ({
        behavior: 'allow',
        ...(r.updatedInput !== undefined ? { updatedInput: { ...r.updatedInput } } : {}),
        ...(suggestions !== undefined &&
        r.updatedPermissions !== undefined &&
        r.updatedPermissions.length > 0
          ? { updatedPermissions: suggestions }
          : {})
      })
    ),
    Match.tag('Answers', 'FreeformResponse', (r): PermissionResult => questionResponseToResult(r)),
    Match.tag(
      'PlanReviewResponse',
      (r): PermissionResult =>
        r.approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'Plan not approved; keep planning.' }
    ),
    Match.tag(
      'Superseded',
      (): PermissionResult => ({
        behavior: 'deny',
        message: 'Superseded by a new message from the user.',
        interrupt: true
      })
    ),
    Match.exhaustive
  )

const askUser = Effect.fn('ClaudeCodeSession.askUser')(function* (
  pendingUserInput: PendingUserInput,
  emit: (message: OutboundMessage) => Effect.Effect<void>,
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2]
) {
  const deferred = yield* pendingUserInput.register(options.toolUseID)

  if (toolName === 'ExitPlanMode') {
    const plan = typeof input.plan === 'string' ? input.plan : ''
    yield* emit(PlanReviewRequested.make({ requestId: options.toolUseID, plan }))
    const resolution = yield* Deferred.await(deferred)
    return toPermissionResult(resolution, options.suggestions)
  }

  const questions = toolName === 'AskUserQuestion' ? decodeQuestions(input.questions) : undefined
  if (questions !== undefined && Result.isSuccess(questions)) {
    yield* emit(
      QuestionRequested.make({
        requestId: options.toolUseID,
        questions: questions.success
      })
    )
  } else {
    if (questions !== undefined) {
      yield* Effect.logWarning(
        'AskUserQuestion input did not match the Question schema; surfacing it as a permission request',
        { requestId: options.toolUseID, issue: questions.failure }
      )
    }
    yield* emit(
      PermissionRequested.make({
        requestId: options.toolUseID,
        toolName,
        input,
        suggestions: options.suggestions
      })
    )
  }

  const resolution = yield* Deferred.await(deferred)
  return toPermissionResult(resolution, options.suggestions)
})

/**
 * Creates the SDK `canUseTool` callback for one agent session. A call to one of the dia `tools`
 * is allowed, because the tool asks the user itself. Every other call is registered in
 * `pendingUserInput`, emitted as a permission, question or plan-review request through `emit`,
 * and answered with the user's resolution.
 */
export const makeCanUseTool =
  (
    tools: ReadonlyArray<DiaTool>,
    pendingUserInput: PendingUserInput,
    emit: (message: OutboundMessage) => Effect.Effect<void>,
    services: Context.Context<never>
  ): CanUseTool =>
  (toolName, input, options) =>
    Effect.runPromiseWith(services)(
      (isDiaToolName(tools, toolName)
        ? Effect.succeed<PermissionResult>({ behavior: 'allow' })
        : askUser(pendingUserInput, emit, toolName, input, options)
      ).pipe(Effect.withSpan('ClaudeCodeSession.canUseTool'))
    )

/**
 * Creates the approval step for a dia tool: it emits a permission request for the call and
 * resolves `true` when the user allows it. Request ids are unique within the session.
 */
export const makeApproveDiaTool = (
  pendingUserInput: PendingUserInput,
  emit: (message: OutboundMessage) => Effect.Effect<void>,
  counter: Ref.Ref<number>
) =>
  Effect.fn('ClaudeCodeSession.approveDiaTool')(function* (
    toolName: string,
    input: Record<string, string>
  ) {
    const sequence = yield* Ref.updateAndGet(counter, (value) => value + 1)
    const now = yield* Clock.currentTimeMillis
    const requestId = `plugin-tool-${now}-${sequence}`
    const deferred = yield* pendingUserInput.register(requestId)
    yield* emit(PermissionRequested.make({ requestId, toolName, input }))
    const resolution = yield* Deferred.await(deferred)
    return resolution._tag === 'Allow'
  })

const resolveRequest = Effect.fn('ClaudeCodeSession.resolveRequest')(function* (
  pendingUserInput: PendingUserInput,
  requestId: string,
  resolution: UserInputResolution
) {
  const matched = yield* pendingUserInput.resolve(requestId, resolution)
  if (!matched) {
    yield* Effect.logWarning('Received a resolution for an unknown requestId', { requestId })
  }
})

const dropPendingRequests = Effect.fn('ClaudeCodeSession.dropPendingRequests')(function* (
  pendingUserInput: PendingUserInput
) {
  const requestIds = yield* pendingUserInput.drop
  if (requestIds.length > 0) {
    yield* Effect.logInfo('Redirected pane; dropping pending user-input requests', { requestIds })
  }
})

/**
 * Supersedes every pending user-input request with a new message: resolves each
 * with `Superseded` so its `canUseTool` denies with `interrupt: true`, aborting
 * the stale turn. Arms `abortExpectedRef` when any request was actually
 * superseded, so the resulting error-subtype turn result is presented as a clean
 * turn end rather than an error.
 */
const supersedePendingRequests = Effect.fn('ClaudeCodeSession.supersedePendingRequests')(function* (
  pendingUserInput: PendingUserInput,
  abortExpectedRef: Ref.Ref<boolean>
) {
  const requestIds = yield* pendingUserInput.interruptAll
  if (requestIds.length > 0) {
    yield* Ref.set(abortExpectedRef, true)
    yield* Effect.logInfo('Superseded pending user-input requests with a new message', {
      requestIds
    })
  }
})

/**
 * Interrupts the live turn on user request: supersedes any pending requests,
 * then calls `query.interrupt()` to abort in-flight generation even when nothing
 * is blocked on a `canUseTool` callback. Arms `abortExpectedRef` so the aborted
 * turn's error result is presented as a clean turn end. A no-op (logged) when no
 * session is live.
 */
const interruptSession = Effect.fn('ClaudeCodeSession.interruptSession')(function* (
  pendingUserInput: PendingUserInput,
  queryRef: Ref.Ref<Option.Option<LiveControlQuery>>,
  abortExpectedRef: Ref.Ref<boolean>
) {
  const requestIds = yield* pendingUserInput.interruptAll
  const queryOpt = yield* Ref.get(queryRef)
  if (Option.isNone(queryOpt)) {
    yield* Effect.logWarning('Cannot interrupt; no live session')
    return
  }
  yield* Ref.set(abortExpectedRef, true)
  yield* Effect.tryPromise({
    try: () => queryOpt.value.interrupt(),
    catch: (cause) => new SessionStreamError({ cause })
  }).pipe(
    Effect.tapCause((cause) => Effect.logError('query.interrupt() failed', { cause })),
    Effect.ignore
  )
  yield* Effect.logInfo('Interrupted session', { superseded: requestIds })
})

const toSDKUserMessage = (text: string, startsTurn = true): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  ...(startsTurn ? {} : { shouldQuery: false })
})

/**
 * The prompt input of one SDK query, read from the session's prompt queue. `prompts` is
 * passed to `query()` as its `prompt`. After `end` runs, no prompt is taken from the queue by
 * this input: a read of `prompts` pending at that moment finishes as done, and every later read
 * finishes as done, including a first read made after `end`. `end` can run more than once.
 */
export interface PromptInput {
  readonly prompts: AsyncIterable<SDKUserMessage>
  readonly end: Effect.Effect<void>
}

/**
 * Opens a {@link PromptInput} over `queue`. Call it once per SDK query, and run `end` before
 * that query is closed, so that a prompt offered after the query closes reaches the next query.
 */
export const openPromptInput = Effect.fnUntraced(function* (
  queue: Queue.Dequeue<SDKUserMessage>
): Effect.fn.Return<PromptInput> {
  const ended = yield* Deferred.make<void>()
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
  const done: IteratorReturnResult<undefined> = { done: true, value: undefined }

  const readOne = Effect.gen(function* () {
    if (yield* Deferred.isDone(ended)) return done
    return yield* Effect.raceFirst(
      Queue.take(queue).pipe(
        Effect.map((value): IteratorYieldResult<SDKUserMessage> => ({ done: false, value }))
      ),
      Deferred.await(ended).pipe(Effect.as(done))
    )
  })

  return {
    prompts: { [Symbol.asyncIterator]: () => ({ next: () => runPromise(readOne) }) },
    end: Deferred.succeed(ended, undefined).pipe(
      Effect.andThen(Effect.logDebug('Prompt input ended'))
    )
  }
})

/**
 * The slice of the live Agent SDK `Query` the session drives directly: restoring
 * files on disk to a checkpoint (`rewindFiles`), aborting an in-flight turn
 * (`interrupt`) and changing the model of later turns (`setModel`). Narrowed so the current query can be held in a `Ref`.
 */
type LiveControlQuery = Pick<Query, 'rewindFiles' | 'interrupt' | 'setModel'>

const isTurnEnd = (message: OutboundMessage): boolean =>
  message._tag === 'TurnErrored' ||
  message._tag === 'TurnCompleted' ||
  message._tag === 'TurnParked'

const resolveContinuesFrom = Effect.fn('ClaudeCodeSession.resolveContinuesFrom')(function* (
  resume: Option.Option<SessionId>,
  branchAt: string | undefined,
  cwd: string
) {
  if (branchAt !== undefined) return Option.some(branchAt)
  if (Option.isNone(resume)) return Option.none<string>()
  return yield* readLastAssistantUuid(resume.value, cwd)
})

const REWIND_FILES_TIMEOUT = Duration.seconds(30)

/**
 * What a session needs to start its queries: the install `path` to run, and where to report a
 * query that refused to start with a known `startup_failure_reason`.
 */
export interface SessionLaunch {
  readonly path: string
  readonly reportStartupFailure: (reason: SDKStartupFailureReason) => Effect.Effect<void>
}

const reportStartupFailure = (message: SDKMessage, launch: SessionLaunch): Effect.Effect<void> =>
  message.type === 'result' &&
  message.subtype !== 'success' &&
  message.startup_failure_reason !== undefined
    ? launch.reportStartupFailure(message.startup_failure_reason)
    : Effect.void

const isSessionNotFound = (message: SDKMessage): boolean =>
  message.type === 'result' &&
  message.subtype === 'error_during_execution' &&
  message.num_turns === 0 &&
  message.errors.some((error) => error.startsWith('No conversation found with session ID'))

const TASK_TRACKING_TOOLS = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']

const resolveRewindAnchor = (
  sessionId: SessionId,
  cwd: string,
  messageUuid: string,
  resumeAnchorUuid: string | undefined
) =>
  resumeAnchorUuid !== undefined
    ? Effect.succeed(Option.some(resumeAnchorUuid))
    : readTurnResumeAnchor(sessionId, cwd, messageUuid)

const runSession = Effect.fn('ClaudeCodeSession.runSession')(
  function* (
    config: PaneConfig,
    promptQueue: Queue.Queue<SDKUserMessage>,
    sessionIdRef: Ref.Ref<Option.Option<SessionId>>,
    branchAtRef: Ref.Ref<Option.Option<string>>,
    queryRef: Ref.Ref<Option.Option<LiveControlQuery>>,
    modeController: PermissionModeController,
    abortExpectedRef: Ref.Ref<boolean>,
    canUseTool: CanUseTool,
    newDiaToolServer: Option.Option<() => McpSdkServerConfigWithInstance>,
    emit: (message: OutboundMessage) => Effect.Effect<void>,
    resume: Option.Option<SessionId>,
    branchAt: string | undefined,
    queryOpened: Deferred.Deferred<void>,
    silentResultsRef: Ref.Ref<number>,
    onTurnEnded: (ok: boolean) => Effect.Effect<void>,
    launch: SessionLaunch,
    notFoundRef: Ref.Ref<boolean>
  ) {
    const continuesFrom = yield* resolveContinuesFrom(resume, branchAt, config.cwd)
    yield* Effect.logInfo('Starting query session', {
      paneId: config.paneId,
      cwd: config.cwd,
      thinkingLevel: config.thinkingLevel,
      permissionMode: config.permissionMode,
      allowedTools: TASK_TRACKING_TOOLS,
      resume: Option.getOrUndefined(resume),
      branchAt,
      continuesFrom: Option.getOrUndefined(continuesFrom)
    })

    const thinking = thinkingOptions(config.thinkingLevel)
    yield* Effect.logInfo('Resolved thinking options', {
      level: config.thinkingLevel,
      options: thinking
    })

    const input = yield* openPromptInput(promptQueue)

    const session = yield* Effect.acquireRelease(
      Effect.sync(() =>
        query({
          prompt: input.prompts,
          options: {
            cwd: config.cwd,
            model: config.model,
            includePartialMessages: true,
            allowedTools: TASK_TRACKING_TOOLS,
            canUseTool,
            ...Option.match(newDiaToolServer, {
              onNone: () => ({}),
              onSome: (newServer) => ({ mcpServers: { [DIA_TOOL_SERVER_KEY]: newServer() } })
            }),
            permissionMode: config.permissionMode,
            allowDangerouslySkipPermissions: true,
            enableFileCheckpointing: true,
            extraArgs: { 'replay-user-messages': null },
            resume: Option.getOrUndefined(resume),
            ...(branchAt !== undefined ? { resumeSessionAt: branchAt, forkSession: true } : {}),
            ...thinking,
            ...installQueryOptions(launch.path)
          }
        })
      ),
      (live) =>
        Effect.logInfo('Closing query', { paneId: config.paneId }).pipe(
          Effect.andThen(input.end),
          Effect.andThen(Effect.sync(() => live.close()))
        )
    )
    yield* modeController.attachQuery(session)
    yield* Ref.set(queryRef, Option.some(session))
    yield* Deferred.succeed(queryOpened, undefined)

    yield* Effect.forkChild(
      emit(SlashCommandsWarming.make({ active: true })).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => session.supportedCommands(),
            catch: (cause) => new SessionStreamError({ cause })
          })
        ),
        Effect.flatMap((commands) =>
          emit(
            SlashCommandsAvailable.make({
              commands: commands.map((command) => ({
                name: command.name,
                description: command.description,
                argumentHint: command.argumentHint
              }))
            })
          )
        ),
        Effect.catch((error) =>
          Effect.logWarning('Failed to warm up slash commands', {
            paneId: config.paneId,
            error
          }).pipe(Effect.andThen(emit(SlashCommandsWarming.make({ active: false }))))
        )
      )
    )

    const events = Stream.fromAsyncIterable(session, (cause) => new SessionStreamError({ cause }))
    const reducer = makeSessionEventReducer(continuesFrom)

    const forward = Effect.fnUntraced(function* (outbound: OutboundMessage) {
      if (outbound._tag === 'SessionStarted') {
        yield* Ref.set(sessionIdRef, Option.some(outbound.sessionId))
        yield* Ref.set(branchAtRef, Option.none())
      } else if (outbound._tag === 'ToolCallStarted' || outbound._tag === 'ToolCallCompleted') {
        yield* Effect.logDebug(
          `Tool call ${outbound._tag === 'ToolCallStarted' ? 'started' : 'completed'}`,
          {
            toolCallId: outbound.toolCallId,
            toolName: outbound.toolName
          }
        )
      }

      if (outbound._tag === 'TurnErrored' || outbound._tag === 'TurnParked') {
        yield* Ref.set(silentResultsRef, 0)
      } else if (outbound._tag === 'TurnCompleted') {
        const silent = yield* Ref.modify(silentResultsRef, (pending) =>
          pending > 0 ? [true, pending - 1] : [false, pending]
        )
        if (silent) {
          yield* Effect.logDebug('Dropped the result of a message that starts no turn', {
            paneId: config.paneId
          })
          return
        }
      }

      const abortExpected = yield* Ref.get(abortExpectedRef)
      if (abortExpected && isTurnEnd(outbound)) {
        yield* Ref.set(abortExpectedRef, false)
        if (outbound._tag === 'TurnErrored' || outbound._tag === 'TurnParked') {
          yield* Effect.logInfo('Suppressing expected turn abort as a clean turn end', {
            paneId: config.paneId
          })
          yield* emit(TurnCompleted.make({}))
          yield* onTurnEnded(true)
          return
        }
      }

      yield* emit(outbound)
      if (isTurnEnd(outbound)) yield* onTurnEnded(outbound._tag === 'TurnCompleted')
    })

    const forwardStep = Effect.fnUntraced(function* (event: SDKMessage) {
      const outbound = reducer.step(event)
      if (outbound.length === 0 && event.type !== 'stream_event') {
        yield* Effect.logDebug('Agent SDK message not shown', {
          type: event.type,
          subtype: 'subtype' in event ? event.subtype : undefined
        })
      }
      yield* Effect.forEach(outbound, forward, { discard: true })
    })

    const markNotFound = (sessionId: SessionId) =>
      Ref.set(notFoundRef, true).pipe(
        Effect.andThen(
          Effect.logInfo('Resume target not found', { paneId: config.paneId, sessionId })
        )
      )

    yield* Stream.runForEach(events, (event) =>
      reportStartupFailure(event, launch).pipe(
        Effect.andThen(
          Option.isSome(resume) && isSessionNotFound(event)
            ? markNotFound(resume.value)
            : forwardStep(event)
        )
      )
    )
  },
  (effect, config) =>
    effect.pipe(
      Effect.scoped,
      Effect.as(Option.none<string>()),
      Effect.catchCause((cause) => {
        const failure = Cause.findErrorOption(cause)
        const underlying =
          Option.isSome(failure) && failure.value instanceof SessionStreamError
            ? failure.value.cause
            : undefined
        const rendered =
          underlying instanceof Error
            ? `${underlying.name}: ${underlying.message}\n${underlying.stack ?? ''}`
            : underlying !== undefined
              ? String(underlying)
              : Cause.pretty(cause)
        return Effect.logError('Agent session failed', { paneId: config.paneId, rendered }).pipe(
          Effect.as(Option.some(rendered))
        )
      })
    )
)

const diaToolServerFactory = (
  tools: ReadonlyArray<DiaTool>,
  pendingUserInput: PendingUserInput,
  emit: (message: OutboundMessage) => Effect.Effect<void>,
  counter: Ref.Ref<number>,
  services: Context.Context<never>
): Option.Option<() => McpSdkServerConfigWithInstance> => {
  if (tools.length === 0) return Option.none()
  const serverOptions = {
    tools,
    approve: makeApproveDiaTool(pendingUserInput, emit, counter),
    run: <A>(effect: Effect.Effect<A>) => Effect.runPromiseWith(services)(effect)
  }
  return Option.some(() => makeDiaToolServer(serverOptions))
}

const ignoredUnstarted =
  (command: string, reason: string) =>
  (..._args: ReadonlyArray<unknown>): Effect.Effect<void> =>
    Effect.logWarning('Ignored a command; the agent session never started', { command, reason })

const unstartedSession = (reason: string): AgentSession => ({
  sendText: ignoredUnstarted('sendText', reason),
  editQueuedText: ignoredUnstarted('editQueuedText', reason),
  removeQueuedText: ignoredUnstarted('removeQueuedText', reason),
  messageQueue: Effect.succeed({ queued: [], held: false }),
  setThinkingLevel: ignoredUnstarted('setThinkingLevel', reason),
  setPermissionMode: ignoredUnstarted('setPermissionMode', reason),
  setModel: ignoredUnstarted('setModel', reason),
  resolvePermission: ignoredUnstarted('resolvePermission', reason),
  resolveQuestion: ignoredUnstarted('resolveQuestion', reason),
  resolvePlanReview: ignoredUnstarted('resolvePlanReview', reason),
  interrupt: ignoredUnstarted('interrupt', reason),
  rewindToCheckpoint: ignoredUnstarted('rewindToCheckpoint', reason),
  resume: ignoredUnstarted('resume', reason)(),
  ended: Effect.succeed(SessionFailed.make({ reason }))
})

/**
 * Starts the Agent SDK session for one pane and returns its {@link AgentSession} controls.
 * `options.config` and `options.resume` choose the working directory, model, modes and, when
 * `resume` is set, the prior conversation to continue. Every event the session produces is
 * passed to `options.emit` in order. The session, its `claude` child process and its pending
 * user-input requests live in the surrounding scope: closing that scope ends them.
 */
export const openClaudeCodeSession = Effect.fn('ClaudeCodeSession.open')(function* (
  options: AgentSessionOptions,
  install: ClaudeInstall,
  reportStartupFailure: SessionLaunch['reportStartupFailure']
): Effect.fn.Return<AgentSession, never, Scope.Scope> {
  const path = yield* install.resolve
  if (Option.isNone(path)) {
    const reason = Option.match(yield* install.override, {
      onNone: () => NOT_INSTALLED_REASON,
      onSome: overrideUnrunnableReason
    })
    yield* Effect.logError('Cannot start an agent session', {
      paneId: options.config.paneId,
      reason
    })
    return unstartedSession(reason)
  }
  const launch: SessionLaunch = { path: path.value, reportStartupFailure }
  const { emit, tools } = options
  const sessionScope = yield* Scope.Scope
  const services = yield* Effect.context<never>()
  const pendingUserInput = makePendingUserInput()
  const modeController = yield* makePermissionModeController
  const canUseTool = makeCanUseTool(tools, pendingUserInput, emit, services)
  const newDiaToolServer = diaToolServerFactory(
    tools,
    pendingUserInput,
    emit,
    yield* Ref.make(0),
    services
  )
  const promptQueue = yield* Queue.unbounded<SDKUserMessage>()
  const sessionIdRef = yield* Ref.make<Option.Option<SessionId>>(Option.none())
  const branchAtRef = yield* Ref.make<Option.Option<string>>(Option.none())
  const queryRef = yield* Ref.make<Option.Option<LiveControlQuery>>(Option.none())
  const abortExpectedRef = yield* Ref.make(false)
  const configRef = yield* Ref.make<Option.Option<PaneConfig>>(Option.none())
  const desiredLevelRef = yield* Ref.make<Option.Option<ThinkingLevel>>(
    Option.some(options.config.thinkingLevel)
  )
  const desiredModelRef = yield* Ref.make(options.config.model)
  const fiberRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none())
  const endedDeferred = yield* Deferred.make<SessionEnd>()
  const restartLock = yield* Semaphore.make(1)
  const queueRef = yield* Ref.make<QueueState>(initialQueueState)
  const silentResultsRef = yield* Ref.make(0)
  const messageCountRef = yield* Ref.make(0)
  const openedAtMillis = yield* Clock.currentTimeMillis

  const offerBatch = Effect.fnUntraced(function* (messages: ReadonlyArray<OutgoingMessage>) {
    yield* Ref.update(silentResultsRef, (pending) => pending + messages.length - 1)
    yield* Effect.forEach(
      messages,
      (message, index) =>
        Queue.offer(promptQueue, toSDKUserMessage(message.text, index === messages.length - 1)),
      { discard: true }
    )
  })

  const transition = (step: (state: QueueState) => QueueTransition) => Ref.modify(queueRef, step)

  const steerInterrupt = Effect.gen(function* () {
    const state = yield* Ref.get(queueRef)
    if (state._tag !== 'QueueRunning' || state.steered.length === 0) {
      yield* Effect.logInfo('Skipped a steer interrupt; the turn it targeted already ended')
      return
    }
    yield* interruptSession(pendingUserInput, queryRef, abortExpectedRef)
  }).pipe(restartLock.withPermits(1))

  const startQuery = Effect.fn('ClaudeCodeSession.startQuery')(function* (
    config: PaneConfig,
    resume: Option.Option<SessionId>,
    branchAt: string | undefined
  ) {
    yield* modeController.seed(config.permissionMode)
    yield* Ref.set(sessionIdRef, resume)
    yield* Ref.set(branchAtRef, Option.fromUndefinedOr(branchAt))
    const queryOpened = yield* Deferred.make<void>()
    const notFoundRef = yield* Ref.make(false)
    const endOf = (failure: Option.Option<string>) =>
      Effect.map(
        Ref.get(notFoundRef),
        (notFound): SessionEnd =>
          notFound && Option.isSome(resume) && branchAt === undefined
            ? SessionNotFound.make({ sessionId: resume.value })
            : SessionFailed.make({
                reason: Option.getOrElse(failure, () => 'Agent session ended unexpectedly')
              })
      )
    const fiber = yield* Effect.forkIn(
      runSession(
        config,
        promptQueue,
        sessionIdRef,
        branchAtRef,
        queryRef,
        modeController,
        abortExpectedRef,
        canUseTool,
        newDiaToolServer,
        emit,
        resume,
        branchAt,
        queryOpened,
        silentResultsRef,
        (ok) =>
          transition(turnEnded(ok)).pipe(
            Effect.flatMap((actions) => performActions(actions)),
            Effect.asVoid
          ),
        launch,
        notFoundRef
      ).pipe(
        Effect.ensuring(Deferred.succeed(queryOpened, undefined)),
        Effect.flatMap(endOf),
        Effect.flatMap((end) => Deferred.succeed(endedDeferred, end)),
        Effect.andThen(transition(sessionEnded)),
        Effect.flatMap((actions) => performActions(actions)),
        Effect.asVoid
      ),
      sessionScope
    )
    yield* Ref.set(configRef, Option.some(config))
    yield* Ref.set(fiberRef, Option.some(fiber))
    yield* Deferred.await(queryOpened)
  })

  const restartForThinkingChange = Effect.fn('ClaudeCodeSession.restartForThinkingChange')(
    function* () {
      const configOpt = yield* Ref.get(configRef)
      const desiredOpt = yield* Ref.get(desiredLevelRef)
      if (Option.isNone(configOpt) || Option.isNone(desiredOpt)) return false
      const config = configOpt.value
      const desired = desiredOpt.value
      if (desired === config.thinkingLevel) return false

      const sessionId = yield* Ref.get(sessionIdRef)
      if (Option.isNone(sessionId)) {
        yield* Effect.logWarning('Cannot apply new thinking level yet; no session to resume', {
          paneId: config.paneId
        })
        return false
      }

      yield* Effect.logInfo('Restarting session to apply new thinking level', {
        paneId: config.paneId,
        from: config.thinkingLevel,
        to: desired
      })

      const fiberOpt = yield* Ref.get(fiberRef)
      if (Option.isSome(fiberOpt)) yield* Fiber.interrupt(fiberOpt.value)
      yield* Ref.set(silentResultsRef, 0)

      const currentModeOpt = yield* modeController.currentMode
      const permissionMode = Option.getOrElse(currentModeOpt, () => config.permissionMode)
      const branchAt = yield* Ref.get(branchAtRef)
      const model = yield* Ref.get(desiredModelRef)
      yield* startQuery(
        { ...config, thinkingLevel: desired, permissionMode, model },
        sessionId,
        Option.getOrUndefined(branchAt)
      )
      return true
    }
  )

  const applyDesiredModel = Effect.fn('ClaudeCodeSession.applyDesiredModel')(function* (
    configBefore: Option.Option<PaneConfig>,
    restarted: boolean
  ) {
    if (Option.isNone(configBefore)) return
    const model = yield* Ref.get(desiredModelRef)
    if (model === configBefore.value.model) return
    if (!restarted) {
      const live = yield* Ref.get(queryRef)
      if (Option.isNone(live)) {
        yield* Effect.logWarning('Cannot change the model yet; no live query', { model })
        return
      }
      const changed = yield* Effect.tryPromise({
        try: () => live.value.setModel(model),
        catch: (cause) => new SessionStreamError({ cause })
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logError('Could not change the model', { model, error }).pipe(Effect.as(false))
        )
      )
      if (!changed) return
      yield* Ref.update(
        configRef,
        Option.map((config) => ({ ...config, model }))
      )
    }
    yield* Effect.logInfo('Changed the model for the next turn', {
      paneId: configBefore.value.paneId,
      from: configBefore.value.model,
      to: model
    })
    yield* emit(ModelChanged.make({ model }))
  })

  const dispatch = Effect.fn('ClaudeCodeSession.dispatch')(
    function* (messages: ReadonlyArray<OutgoingMessage>) {
      const messageIds = messages.map((message) => message.id)
      if (yield* Deferred.isDone(endedDeferred)) {
        yield* Effect.logWarning('Dropped a dispatch; the session has ended', { messageIds })
        return
      }
      const configBefore = yield* Ref.get(configRef)
      const restarted = yield* restartForThinkingChange()
      yield* applyDesiredModel(configBefore, restarted)
      yield* supersedePendingRequests(pendingUserInput, abortExpectedRef)
      yield* emit(UserMessagesSent.make({ messages }))
      yield* offerBatch(messages)
      yield* Effect.logInfo('Sent user messages as one turn', { messageIds })
    },
    restartLock.withPermits(1),
    Effect.ensuring(transition(dispatchEnded))
  )

  function performActions(
    actions: ReadonlyArray<QueueAction>,
    interrupt: Effect.Effect<void> = interruptSession(pendingUserInput, queryRef, abortExpectedRef)
  ): Effect.Effect<ReadonlyArray<Fiber.Fiber<void>>> {
    return Effect.forEach(actions, (action) =>
      Match.valueTags(action, {
        DispatchAction: ({ messages }) => Effect.forkIn(dispatch(messages), sessionScope),
        InterruptAction: () =>
          Effect.logInfo('Interrupting the running turn').pipe(
            Effect.andThen(interrupt),
            Effect.as(undefined)
          ),
        QueueChangedAction: ({ queued, held }) =>
          Effect.logDebug('Message queue changed', { queued: queued.length, held }).pipe(
            Effect.andThen(emit(MessageQueueChanged.make({ queued, held }))),
            Effect.as(undefined)
          )
      })
    ).pipe(Effect.map((results) => results.filter(Predicate.isNotUndefined)))
  }

  const rewindToCheckpoint = Effect.fn('ClaudeCodeSession.rewindToCheckpoint')(function* (
    messageUuid: string,
    resumeAnchorUuid: string | undefined
  ) {
    const configOpt = yield* Ref.get(configRef)
    const sessionIdOpt = yield* Ref.get(sessionIdRef)
    const queryOpt = yield* Ref.get(queryRef)
    if (Option.isNone(configOpt) || Option.isNone(sessionIdOpt) || Option.isNone(queryOpt)) {
      yield* Effect.logWarning('Cannot rewind; no live session to rewind', { messageUuid })
      return
    }
    const config = configOpt.value

    const anchor = yield* Effect.result(
      resolveRewindAnchor(sessionIdOpt.value, config.cwd, messageUuid, resumeAnchorUuid)
    )
    if (Result.isFailure(anchor)) {
      yield* Effect.logWarning('Rewind aborted; the turn is not in the session transcript', {
        paneId: config.paneId,
        sessionId: sessionIdOpt.value,
        messageUuid
      })
      return
    }

    const result = yield* Effect.tryPromise({
      try: () => queryOpt.value.rewindFiles(messageUuid),
      catch: (cause) => new SessionStreamError({ cause })
    }).pipe(
      Effect.timeout(REWIND_FILES_TIMEOUT),
      Effect.tapCause((cause) =>
        Effect.logError('rewindFiles failed', { paneId: config.paneId, messageUuid, cause })
      ),
      Effect.option
    )
    if (Option.isNone(result) || !result.value.canRewind) {
      yield* Effect.logWarning('Rewind aborted; files were not rewound', {
        paneId: config.paneId,
        messageUuid,
        error: Option.isSome(result) ? result.value.error : undefined
      })
      return
    }

    yield* Effect.logInfo('Rewound files to checkpoint; forking conversation', {
      paneId: config.paneId,
      messageUuid,
      resumeAnchorUuid: Option.getOrUndefined(anchor.success),
      filesChanged: result.value.filesChanged?.length ?? 0
    })

    const fiberOpt = yield* Ref.get(fiberRef)
    if (Option.isSome(fiberOpt)) yield* Fiber.interrupt(fiberOpt.value)
    yield* dropPendingRequests(pendingUserInput)

    const currentModeOpt = yield* modeController.currentMode
    const permissionMode = Option.getOrElse(currentModeOpt, () => config.permissionMode)
    if (Option.isSome(anchor.success)) {
      yield* startQuery({ ...config, permissionMode }, sessionIdOpt, anchor.success.value)
    } else {
      yield* startQuery({ ...config, permissionMode }, Option.none(), undefined)
    }
    yield* Ref.set(silentResultsRef, 0)
    yield* Ref.set(abortExpectedRef, false)
    yield* emit(RewoundToCheckpoint.make({ messageUuid }))
    yield* performActions(yield* transition(rewound))
  }, restartLock.withPermits(1))

  yield* startQuery(options.config, options.resume, undefined)

  const nextMessage = (text: string) =>
    Ref.updateAndGet(messageCountRef, (sent) => sent + 1).pipe(
      Effect.map((count): OutgoingMessage => ({ id: `${openedAtMillis}-${count}`, text }))
    )

  const sendText = Effect.fn('ClaudeCodeSession.sendText')(function* (
    text: string,
    mode: SendMode
  ) {
    const message = yield* nextMessage(text)
    yield* Effect.logDebug('Accepted a user message', { messageId: message.id, mode })
    const dispatches = yield* performActions(yield* transition(send(message, mode)), steerInterrupt)
    yield* Effect.forEach(dispatches, Fiber.join, { discard: true })
  })

  const resume = Effect.gen(function* () {
    const message = yield* nextMessage(RESUME_TEXT)
    yield* Effect.logInfo('Resuming a parked turn', { messageId: message.id })
    const dispatches = yield* performActions(yield* transition(resumeQueue(message)))
    yield* Effect.forEach(dispatches, Fiber.join, { discard: true })
  }).pipe(Effect.withSpan('ClaudeCodeSession.resume'))

  const changeQueue = Effect.fn('ClaudeCodeSession.changeQueue')(function* (
    step: (state: QueueState) => QueueTransition
  ) {
    yield* performActions(yield* transition(step))
  })

  const resolvePlanReview = Effect.fn('ClaudeCodeSession.resolvePlanReview')(function* (
    requestId: string,
    approved: boolean
  ) {
    const restored = yield* modeController.resolvePlan(approved)
    if (Option.isSome(restored)) {
      yield* emit(PermissionModeChanged.make({ mode: restored.value }))
    }
    yield* resolveRequest(pendingUserInput, requestId, PlanReviewResponse.make({ approved }))
  })

  return {
    sendText,
    editQueuedText: (messageId, text) => changeQueue(edit(messageId, text)),
    removeQueuedText: (messageId) => changeQueue(remove(messageId)),
    messageQueue: Ref.get(queueRef).pipe(Effect.map(snapshotOf)),
    setThinkingLevel: (level) => Ref.set(desiredLevelRef, Option.some(level)),
    setModel: (model) => Ref.set(desiredModelRef, model),
    setPermissionMode: (mode) => modeController.applyMode(mode),
    resolvePermission: (requestId, response) =>
      resolveRequest(pendingUserInput, requestId, response),
    resolveQuestion: (requestId, response) => resolveRequest(pendingUserInput, requestId, response),
    resolvePlanReview,
    interrupt: () => changeQueue(stopRequested),
    rewindToCheckpoint,
    resume,
    ended: Deferred.await(endedDeferred)
  }
})
