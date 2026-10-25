import {
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  type AgentSession,
  type AgentSessionOptions,
  type DiaTool,
  makePendingUserInput,
  type OutboundMessage,
  type PendingUserInput,
  PermissionModeChanged,
  PermissionRequested,
  PlanReviewRequested,
  PlanReviewResponse,
  Question,
  QuestionRequested,
  RewoundToCheckpoint,
  SlashCommandsAvailable,
  SlashCommandsWarming,
  TurnCompleted,
  type UserInputResolution
} from '@dia/plugin'
import type { QuestionResponse } from '@shared/domain/attention'
import type { PaneConfig, SessionId, ThinkingLevel } from '@shared/domain/pane'
import {
  Cause,
  Clock,
  type Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  Match,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream
} from 'effect'
import { resolveClaudeExecutable } from './claude-executable'
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

const claudeExecutablePath = resolveClaudeExecutable()

const toSDKUserMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null
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
 * files on disk to a checkpoint (`rewindFiles`) and aborting an in-flight turn
 * (`interrupt`). Narrowed so the current query can be held in a `Ref`.
 */
type LiveControlQuery = Pick<Query, 'rewindFiles' | 'interrupt'>

const isTurnEnd = (message: OutboundMessage): boolean =>
  message._tag === 'TurnErrored' || message._tag === 'TurnCompleted'

const resolveContinuesFrom = Effect.fn('ClaudeCodeSession.resolveContinuesFrom')(function* (
  resume: Option.Option<SessionId>,
  branchAt: string | undefined,
  cwd: string
) {
  if (branchAt !== undefined) return Option.some(branchAt)
  if (Option.isNone(resume)) return Option.none<string>()
  return yield* readLastAssistantUuid(resume.value, cwd)
})

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
    queryRef: Ref.Ref<Option.Option<LiveControlQuery>>,
    modeController: PermissionModeController,
    abortExpectedRef: Ref.Ref<boolean>,
    canUseTool: CanUseTool,
    newDiaToolServer: Option.Option<() => McpSdkServerConfigWithInstance>,
    emit: (message: OutboundMessage) => Effect.Effect<void>,
    resume: Option.Option<SessionId>,
    branchAt: string | undefined,
    queryOpened: Deferred.Deferred<void>
  ) {
    const continuesFrom = yield* resolveContinuesFrom(resume, branchAt, config.cwd)
    yield* Effect.logInfo('Starting query session', {
      paneId: config.paneId,
      cwd: config.cwd,
      thinkingLevel: config.thinkingLevel,
      permissionMode: config.permissionMode,
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
            canUseTool,
            ...Option.match(newDiaToolServer, {
              onNone: () => ({}),
              onSome: (newServer) => ({ mcpServers: { [DIA_TOOL_SERVER_KEY]: newServer() } })
            }),
            permissionMode: config.permissionMode,
            enableFileCheckpointing: true,
            extraArgs: { 'replay-user-messages': null },
            resume: Option.getOrUndefined(resume),
            ...(branchAt !== undefined ? { resumeSessionAt: branchAt, forkSession: true } : {}),
            ...thinking,
            ...(claudeExecutablePath !== undefined
              ? { pathToClaudeCodeExecutable: claudeExecutablePath }
              : {})
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
      } else if (outbound._tag === 'ToolCallStarted' || outbound._tag === 'ToolCallCompleted') {
        yield* Effect.logDebug(
          `Tool call ${outbound._tag === 'ToolCallStarted' ? 'started' : 'completed'}`,
          {
            toolCallId: outbound.toolCallId,
            toolName: outbound.toolName
          }
        )
      }

      const abortExpected = yield* Ref.get(abortExpectedRef)
      if (abortExpected && isTurnEnd(outbound)) {
        yield* Ref.set(abortExpectedRef, false)
        if (outbound._tag === 'TurnErrored') {
          yield* Effect.logInfo('Suppressing expected turn abort as a clean turn end', {
            paneId: config.paneId
          })
          yield* emit(TurnCompleted.make({}))
          return
        }
      }

      yield* emit(outbound)
    })

    yield* Stream.runForEach(events, (event) =>
      Effect.forEach(reducer.step(event), forward, { discard: true })
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

/**
 * Starts the Agent SDK session for one pane and returns its {@link AgentSession} controls.
 * `options.config` and `options.resume` choose the working directory, model, modes and, when
 * `resume` is set, the prior conversation to continue. Every event the session produces is
 * passed to `options.emit` in order. The session, its `claude` child process and its pending
 * user-input requests live in the surrounding scope: closing that scope ends them.
 */
export const openClaudeCodeSession = Effect.fn('ClaudeCodeSession.open')(function* (
  options: AgentSessionOptions
): Effect.fn.Return<AgentSession, never, Scope.Scope> {
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
  const queryRef = yield* Ref.make<Option.Option<LiveControlQuery>>(Option.none())
  const abortExpectedRef = yield* Ref.make(false)
  const configRef = yield* Ref.make<Option.Option<PaneConfig>>(Option.none())
  const desiredLevelRef = yield* Ref.make<Option.Option<ThinkingLevel>>(
    Option.some(options.config.thinkingLevel)
  )
  const fiberRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none())
  const endedDeferred = yield* Deferred.make<string>()
  const restartLock = yield* Semaphore.make(1)

  const startQuery = Effect.fn('ClaudeCodeSession.startQuery')(function* (
    config: PaneConfig,
    resume: Option.Option<SessionId>,
    branchAt: string | undefined
  ) {
    yield* modeController.seed(config.permissionMode)
    yield* Ref.set(sessionIdRef, resume)
    const queryOpened = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkIn(
      runSession(
        config,
        promptQueue,
        sessionIdRef,
        queryRef,
        modeController,
        abortExpectedRef,
        canUseTool,
        newDiaToolServer,
        emit,
        resume,
        branchAt,
        queryOpened
      ).pipe(
        Effect.ensuring(Deferred.succeed(queryOpened, undefined)),
        Effect.flatMap((failure) =>
          Deferred.succeed(
            endedDeferred,
            Option.getOrElse(failure, () => 'Agent session ended unexpectedly')
          )
        ),
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
      if (Option.isNone(configOpt) || Option.isNone(desiredOpt)) return
      const config = configOpt.value
      const desired = desiredOpt.value
      if (desired === config.thinkingLevel) return

      const sessionId = yield* Ref.get(sessionIdRef)
      if (Option.isNone(sessionId)) {
        yield* Effect.logWarning('Cannot apply new thinking level yet; no session to resume', {
          paneId: config.paneId
        })
        return
      }

      yield* Effect.logInfo('Restarting session to apply new thinking level', {
        paneId: config.paneId,
        from: config.thinkingLevel,
        to: desired
      })

      const fiberOpt = yield* Ref.get(fiberRef)
      if (Option.isSome(fiberOpt)) yield* Fiber.interrupt(fiberOpt.value)

      const currentModeOpt = yield* modeController.currentMode
      const permissionMode = Option.getOrElse(currentModeOpt, () => config.permissionMode)
      yield* startQuery({ ...config, thinkingLevel: desired, permissionMode }, sessionId, undefined)
    }
  )

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
    yield* emit(RewoundToCheckpoint.make({ messageUuid }))
  }, restartLock.withPermits(1))

  yield* startQuery(options.config, options.resume, undefined)

  const sendText = Effect.fn('ClaudeCodeSession.sendText')(function* (text: string) {
    yield* restartForThinkingChange()
    yield* supersedePendingRequests(pendingUserInput, abortExpectedRef)
    yield* Queue.offer(promptQueue, toSDKUserMessage(text))
  }, restartLock.withPermits(1))

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
    setThinkingLevel: (level) => Ref.set(desiredLevelRef, Option.some(level)),
    setPermissionMode: (mode) => modeController.applyMode(mode),
    resolvePermission: (requestId, response) =>
      resolveRequest(pendingUserInput, requestId, response),
    resolveQuestion: (requestId, response) => resolveRequest(pendingUserInput, requestId, response),
    resolvePlanReview,
    interrupt: () => interruptSession(pendingUserInput, queryRef, abortExpectedRef),
    rewindToCheckpoint,
    ended: Deferred.await(endedDeferred)
  }
})
