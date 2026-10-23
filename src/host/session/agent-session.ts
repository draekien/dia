import { createRequire } from 'node:module'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolving the SDK's native binary path is a synchronous filesystem-path computation outside any Effect.
import { sep } from 'node:path'
import {
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  type PermissionResponse,
  PlanReviewResponse,
  Question,
  type QuestionResponse
} from '@shared/domain/attention'
import type { PaneConfig, PermissionMode, ThinkingLevel } from '@shared/domain/pane'
import {
  Cause,
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
  Stream
} from 'effect'
import { makeSessionEventReducer } from './agent-session-reducer'
import {
  makePendingUserInput,
  type PendingUserInput,
  type UserInputResolution
} from './pending-user-input'
import {
  makePermissionModeController,
  type PermissionModeController
} from './permission-mode-controller'
import {
  type OutboundMessage,
  PermissionModeChanged,
  PermissionRequested,
  PlanReviewRequested,
  QuestionRequested,
  RewoundToCheckpoint,
  SlashCommandsAvailable,
  SlashCommandsWarming,
  TurnCompleted
} from './protocol'
import { thinkingOptions } from './thinking-options'

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
 * `AskUserQuestion` tool receives. The exact accepted shape is a real-session
 * discovery item (tech-spec §9, Bullet 06 T8); this mirrors the SDK's
 * `AskUserQuestionOutput` (questions plus comma-joined answers, and an optional
 * freeform response). Kept isolated so T8 can correct it in one place.
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

const makeCanUseTool =
  (
    pendingUserInput: PendingUserInput,
    emit: (message: OutboundMessage) => Effect.Effect<void>,
    services: Context.Context<never>
  ): CanUseTool =>
  (toolName, input, options) =>
    Effect.runPromiseWith(services)(
      Effect.gen(function* () {
        const deferred = yield* pendingUserInput.register(options.toolUseID)

        if (toolName === 'ExitPlanMode') {
          const plan = typeof input.plan === 'string' ? input.plan : ''
          yield* emit(PlanReviewRequested.make({ requestId: options.toolUseID, plan }))
          const resolution = yield* Deferred.await(deferred)
          return toPermissionResult(resolution, options.suggestions)
        }

        const questions =
          toolName === 'AskUserQuestion' ? decodeQuestions(input.questions) : undefined
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
      }).pipe(Effect.withSpan('AgentSession.canUseTool'))
    )

const resolveRequest = Effect.fn('AgentSession.resolveRequest')(function* (
  pendingUserInput: PendingUserInput,
  requestId: string,
  resolution: UserInputResolution
) {
  const matched = yield* pendingUserInput.resolve(requestId, resolution)
  if (!matched) {
    yield* Effect.logWarning('Received a resolution for an unknown requestId', { requestId })
  }
})

const dropPendingRequests = Effect.fn('AgentSession.dropPendingRequests')(function* (
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
const supersedePendingRequests = Effect.fn('AgentSession.supersedePendingRequests')(function* (
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
const interruptSession = Effect.fn('AgentSession.interruptSession')(function* (
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

/**
 * Resolves the Agent SDK's bundled native Claude Code binary to a real,
 * spawnable filesystem path. In a packaged app the SDK resolves this binary to
 * its `app.asar` virtual path, which the OS cannot execute; this redirects it
 * to the unpacked copy (`app.asar.unpacked`) so the SDK can spawn it. Returns
 * `undefined` when the binary can't be resolved (e.g. an unpackaged dev run),
 * letting the SDK fall back to its own resolution.
 */
const resolveClaudeExecutable = (): string | undefined => {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  try {
    const resolved = createRequire(import.meta.url).resolve(`${nativePackage}/claude${ext}`)
    return resolved.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  } catch {
    return undefined
  }
}

const claudeExecutablePath = resolveClaudeExecutable()

const toSDKUserMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null
})

/**
 * The slice of the live Agent SDK `Query` main-process handlers drive: restoring
 * files on disk to a checkpoint (`rewindFiles`) and aborting an in-flight turn
 * (`interrupt`). Narrowed so the current query can be held in a `Ref` and a fake
 * supplied in tests.
 */
type LiveControlQuery = Pick<Query, 'rewindFiles' | 'interrupt'>

const runSession = Effect.fn('AgentSession.runSession')(
  function* (
    config: PaneConfig,
    promptQueue: Queue.Queue<SDKUserMessage>,
    sessionIdRef: Ref.Ref<Option.Option<string>>,
    queryRef: Ref.Ref<Option.Option<LiveControlQuery>>,
    modeController: PermissionModeController,
    abortExpectedRef: Ref.Ref<boolean>,
    canUseTool: CanUseTool,
    emit: (message: OutboundMessage) => Effect.Effect<void>,
    resume: string | undefined,
    branchAt: string | undefined
  ) {
    yield* Effect.logInfo('Starting query session', {
      paneId: config.paneId,
      cwd: config.cwd,
      thinkingLevel: config.thinkingLevel,
      permissionMode: config.permissionMode,
      resume,
      branchAt
    })

    const promptIterable = Stream.toAsyncIterable(Stream.fromQueue(promptQueue))

    const session = yield* Effect.acquireRelease(
      Effect.sync(() =>
        query({
          prompt: promptIterable,
          options: {
            cwd: config.cwd,
            model: config.model,
            includePartialMessages: true,
            canUseTool,
            permissionMode: config.permissionMode,
            enableFileCheckpointing: true,
            extraArgs: { 'replay-user-messages': null },
            resume,
            ...(branchAt !== undefined ? { resumeSessionAt: branchAt, forkSession: true } : {}),
            ...thinkingOptions(config.thinkingLevel),
            ...(claudeExecutablePath !== undefined
              ? { pathToClaudeCodeExecutable: claudeExecutablePath }
              : {})
          }
        })
      ),
      (live) =>
        Effect.logInfo('Closing query', { paneId: config.paneId }).pipe(
          Effect.andThen(Effect.sync(() => live.close()))
        )
    )
    yield* modeController.attachQuery(session)
    yield* Ref.set(queryRef, Option.some(session))

    // Warm up the pane's slash-command list without waiting for the user's first turn.
    // The SDK runs its control-protocol initialize() eagerly when query() is created, and
    // supportedCommands() awaits that, so the full list (with descriptions and argument
    // hints -- richer than the streamed init message's names-only list) is available right
    // away on both a cold start and a resume. Forked so it never blocks reading the event
    // stream, and tied to this session run so a restart interrupts it. The warming signal
    // brackets the await so the renderer can show a "loading commands" indicator; success
    // ends it via SlashCommandsAvailable, failure via SlashCommandsWarming(active: false).
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
    const reducer = makeSessionEventReducer()

    yield* Stream.runForEach(events, (event) =>
      Effect.forEach(reducer.step(event), (outbound) =>
        Effect.gen(function* () {
          if (outbound._tag === 'SessionStarted') {
            yield* Ref.set(sessionIdRef, Option.some(outbound.sessionId))
          } else if (outbound._tag === 'ToolCallStarted') {
            yield* Effect.logDebug('Tool call started', {
              toolCallId: outbound.toolCallId,
              toolName: outbound.toolName
            })
          } else if (outbound._tag === 'ToolCallCompleted') {
            yield* Effect.logDebug('Tool call completed', {
              toolCallId: outbound.toolCallId,
              toolName: outbound.toolName
            })
          }

          // A turn aborted by a supersede/interrupt returns an error-subtype result the reducer
          // maps to TurnErrored; the abort was deliberate, so present it as a clean turn end
          // rather than lighting the pane's error pulse. The flag is armed for exactly one
          // terminal outcome and cleared once one arrives.
          const abortExpected = yield* Ref.get(abortExpectedRef)
          if (
            abortExpected &&
            (outbound._tag === 'TurnErrored' || outbound._tag === 'TurnCompleted')
          ) {
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

/**
 * Live control surface of one pane's Agent SDK session, returned by {@link makeAgentSession}.
 * Every method returns once the command has been applied to the session; none waits for the
 * agent's reply, which arrives through the `emit` callback given at construction.
 */
export interface AgentSession {
  readonly sendText: (text: string) => Effect.Effect<void>
  readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void>
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>
  readonly resolvePermission: (
    requestId: string,
    response: PermissionResponse
  ) => Effect.Effect<void>
  readonly resolveQuestion: (requestId: string, response: QuestionResponse) => Effect.Effect<void>
  readonly resolvePlanReview: (requestId: string, approved: boolean) => Effect.Effect<void>
  readonly interrupt: () => Effect.Effect<void>
  readonly rewindToCheckpoint: (
    messageUuid: string,
    resumeAnchorUuid: string | undefined
  ) => Effect.Effect<void>
  /**
   * Completes with a description of why the session ended on its own: its event stream failed
   * or finished without the pane being closed. Never completes for a restart the session
   * performs itself (thinking-level change, rewind) or for closing the scope it was made in.
   */
  readonly ended: Effect.Effect<string>
}

/**
 * Starts the Agent SDK session for one pane and returns its {@link AgentSession} controls.
 * `config` and `resume` choose the working directory, model, modes and, when `resume` is set,
 * the prior session to continue. Every event the session produces is passed to `emit` in
 * order. The session, its `claude` child process and its pending user-input requests live in
 * the surrounding scope: closing that scope ends them.
 */
export const makeAgentSession = Effect.fn('AgentSession.make')(function* (options: {
  readonly config: PaneConfig
  readonly resume: string | undefined
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
}): Effect.fn.Return<AgentSession, never, Scope.Scope> {
  const { emit } = options
  const sessionScope = yield* Scope.Scope
  const services = yield* Effect.context<never>()
  const pendingUserInput = makePendingUserInput()
  const canUseTool = makeCanUseTool(pendingUserInput, emit, services)
  const promptQueue = yield* Queue.unbounded<SDKUserMessage>()
  const sessionIdRef = yield* Ref.make<Option.Option<string>>(Option.none())
  const queryRef = yield* Ref.make<Option.Option<LiveControlQuery>>(Option.none())
  const abortExpectedRef = yield* Ref.make(false)
  const configRef = yield* Ref.make<Option.Option<PaneConfig>>(Option.none())
  const desiredLevelRef = yield* Ref.make<Option.Option<ThinkingLevel>>(
    Option.some(options.config.thinkingLevel)
  )
  const fiberRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none())
  const modeController = yield* makePermissionModeController
  const endedDeferred = yield* Deferred.make<string>()

  const startSession = Effect.fn('AgentSession.startSession')(function* (
    config: PaneConfig,
    resume: string | undefined,
    branchAt: string | undefined
  ) {
    yield* modeController.seed(config.permissionMode)
    const fiber = yield* Effect.forkIn(
      runSession(
        config,
        promptQueue,
        sessionIdRef,
        queryRef,
        modeController,
        abortExpectedRef,
        canUseTool,
        emit,
        resume,
        branchAt
      ).pipe(
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
  })

  const restartForThinkingChange = Effect.fn('AgentSession.restartForThinkingChange')(function* () {
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
    yield* startSession(
      { ...config, thinkingLevel: desired, permissionMode },
      sessionId.value,
      undefined
    )
  })

  const rewindToCheckpoint = Effect.fn('AgentSession.rewindToCheckpoint')(function* (
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
    const sessionId = sessionIdOpt.value

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
      resumeAnchorUuid,
      filesChanged: result.value.filesChanged?.length ?? 0
    })

    const fiberOpt = yield* Ref.get(fiberRef)
    if (Option.isSome(fiberOpt)) yield* Fiber.interrupt(fiberOpt.value)
    yield* dropPendingRequests(pendingUserInput)

    const currentModeOpt = yield* modeController.currentMode
    const permissionMode = Option.getOrElse(currentModeOpt, () => config.permissionMode)
    if (resumeAnchorUuid !== undefined) {
      yield* startSession({ ...config, permissionMode }, sessionId, resumeAnchorUuid)
    } else {
      yield* startSession({ ...config, permissionMode }, undefined, undefined)
    }
    yield* emit(RewoundToCheckpoint.make({ messageUuid }))
  })

  yield* startSession(options.config, options.resume, undefined)

  const sendText = Effect.fn('AgentSession.sendText')(function* (text: string) {
    yield* restartForThinkingChange()
    yield* supersedePendingRequests(pendingUserInput, abortExpectedRef)
    yield* Queue.offer(promptQueue, toSDKUserMessage(text))
  })

  const resolvePlanReview = Effect.fn('AgentSession.resolvePlanReview')(function* (
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
