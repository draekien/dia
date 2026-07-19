import { createRequire } from 'node:module'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolving the SDK's native binary path is a synchronous filesystem-path computation outside any Effect.
import { sep } from 'node:path'
import {
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { PlanReviewResponse, Question, type QuestionResponse } from '@shared/domain/attention'
import type { PaneConfig, ThinkingLevel } from '@shared/domain/pane'
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Either,
  Fiber,
  Layer,
  Logger,
  LogLevel,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Stream
} from 'effect'
import { makeLoggerLive } from '../logger'
import { makeSessionEventReducer } from './agent-session-reducer'
import { makePendingUserInput, type UserInputResolution } from './pending-user-input'
import {
  makePermissionModeController,
  type PermissionModeController
} from './permission-mode-controller'
import {
  InboundMessage,
  OutboundMessage,
  PermissionModeChanged,
  PermissionRequested,
  PlanReviewRequested,
  QuestionRequested,
  SlashCommandsAvailable,
  SlashCommandsWarming
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

const decodeInbound = Schema.decodeUnknownEither(InboundMessage)
const encodeOutbound = Schema.encodeSync(OutboundMessage)

const port = process.parentPort

const postOutbound = (message: OutboundMessage): Effect.Effect<void> =>
  Effect.sync(() => port.postMessage(encodeOutbound(message)))

const pendingUserInput = makePendingUserInput()

const decodeQuestions = Schema.decodeUnknownEither(Schema.Array(Question))

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
    Match.exhaustive
  )

const canUseTool: CanUseTool = (toolName, input, options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const deferred = yield* pendingUserInput.register(options.toolUseID)

      if (toolName === 'ExitPlanMode') {
        const plan = typeof input.plan === 'string' ? input.plan : ''
        yield* postOutbound(PlanReviewRequested.make({ requestId: options.toolUseID, plan }))
        const resolution = yield* Deferred.await(deferred)
        return toPermissionResult(resolution, options.suggestions)
      }

      const questions =
        toolName === 'AskUserQuestion' ? decodeQuestions(input.questions) : undefined
      if (questions !== undefined && Either.isRight(questions)) {
        yield* postOutbound(
          QuestionRequested.make({
            requestId: options.toolUseID,
            questions: questions.right
          })
        )
      } else {
        if (questions !== undefined) {
          yield* Effect.logWarning(
            'AskUserQuestion input did not match the Question schema; surfacing it as a permission request',
            { requestId: options.toolUseID, issue: questions.left }
          )
        }
        yield* postOutbound(
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
  requestId: string,
  resolution: UserInputResolution
) {
  const matched = yield* pendingUserInput.resolve(requestId, resolution)
  if (!matched) {
    yield* Effect.logWarning('Received a resolution for an unknown requestId', { requestId })
  }
})

const dropPendingRequests = Effect.fn('AgentSession.dropPendingRequests')(function* () {
  const requestIds = yield* pendingUserInput.drop
  if (requestIds.length > 0) {
    yield* Effect.logInfo('Redirected pane; dropping pending user-input requests', { requestIds })
  }
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

const runSession = Effect.fn('AgentSession.runSession')(
  function* (
    config: PaneConfig,
    promptQueue: Queue.Queue<SDKUserMessage>,
    sessionIdRef: Ref.Ref<Option.Option<string>>,
    modeController: PermissionModeController,
    resume: string | undefined
  ) {
    yield* Effect.logInfo('Starting query session', {
      paneId: config.paneId,
      cwd: config.cwd,
      thinkingLevel: config.thinkingLevel,
      permissionMode: config.permissionMode,
      resume
    })

    const promptIterable = Stream.toAsyncIterable(Stream.fromQueue(promptQueue))

    const session = query({
      prompt: promptIterable,
      options: {
        cwd: config.cwd,
        model: config.model,
        includePartialMessages: true,
        canUseTool,
        permissionMode: config.permissionMode,
        resume,
        ...thinkingOptions(config.thinkingLevel),
        ...(claudeExecutablePath !== undefined
          ? { pathToClaudeCodeExecutable: claudeExecutablePath }
          : {})
      }
    })
    yield* modeController.attachQuery(session)

    // Warm up the pane's slash-command list without waiting for the user's first turn.
    // The SDK runs its control-protocol initialize() eagerly when query() is created, and
    // supportedCommands() awaits that, so the full list (with descriptions and argument
    // hints -- richer than the streamed init message's names-only list) is available right
    // away on both a cold start and a resume. Forked so it never blocks reading the event
    // stream, and tied to this session run so a restart interrupts it. The warming signal
    // brackets the await so the renderer can show a "loading commands" indicator; success
    // ends it via SlashCommandsAvailable, failure via SlashCommandsWarming(active: false).
    yield* Effect.fork(
      postOutbound(SlashCommandsWarming.make({ active: true })).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => session.supportedCommands(),
            catch: (cause) => new SessionStreamError({ cause })
          })
        ),
        Effect.flatMap((commands) =>
          postOutbound(
            SlashCommandsAvailable.make({
              commands: commands.map((command) => ({
                name: command.name,
                description: command.description,
                argumentHint: command.argumentHint
              }))
            })
          )
        ),
        Effect.catchAll((error) =>
          Effect.logWarning('Failed to warm up slash commands', {
            paneId: config.paneId,
            error
          }).pipe(Effect.andThen(postOutbound(SlashCommandsWarming.make({ active: false }))))
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
          yield* postOutbound(outbound)
        })
      )
    )
  },
  (effect, config) =>
    effect.pipe(
      Effect.catchAllCause((cause) => {
        const failure = Cause.failureOption(cause)
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
        return Effect.logError('Agent session failed', { paneId: config.paneId, rendered })
      })
    )
)

const program = Effect.gen(function* () {
  const promptQueue = yield* Queue.unbounded<SDKUserMessage>()
  const sessionIdRef = yield* Ref.make<Option.Option<string>>(Option.none())
  const configRef = yield* Ref.make<Option.Option<PaneConfig>>(Option.none())
  const desiredLevelRef = yield* Ref.make<Option.Option<ThinkingLevel>>(Option.none())
  const fiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void>>>(Option.none())
  const modeController = yield* makePermissionModeController

  const startSession = Effect.fn('AgentSession.startSession')(function* (
    config: PaneConfig,
    resume: string | undefined
  ) {
    yield* modeController.seed(config.permissionMode)
    const fiber = yield* Effect.forkScoped(
      runSession(config, promptQueue, sessionIdRef, modeController, resume)
    )
    yield* Ref.set(configRef, Option.some(config))
    yield* Ref.set(fiberRef, Option.some(fiber))
  })

  // A running query's thinking/effort options are fixed for its lifetime, so a level change is
  // deferred to the next user turn: we tear the current query down and resume it fresh with the
  // new options before offering the pending prompt. Resuming (rather than a cold start) preserves
  // the conversation. A no-op when the level is unchanged or no session has started yet.
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
    yield* startSession({ ...config, thinkingLevel: desired, permissionMode }, sessionId.value)
  })

  const rawInbound = Stream.async<unknown>((emit) => {
    const listener = (event: { data: unknown }): void => void emit.single(event.data)
    port.on('message', listener)
    return Effect.sync(() => port.off('message', listener))
  })

  yield* Stream.runForEach(rawInbound, (raw) =>
    Effect.gen(function* () {
      const decoded = decodeInbound(raw)
      if (Either.isLeft(decoded)) {
        yield* Effect.logWarning('Dropped malformed inbound message', { issue: decoded.left })
        return
      }

      const inbound = decoded.right
      if (inbound._tag === 'Init') {
        yield* Ref.set(desiredLevelRef, Option.some(inbound.config.thinkingLevel))
        yield* startSession(inbound.config, inbound.resume)
      } else if (inbound._tag === 'SetThinkingLevel') {
        yield* Ref.set(desiredLevelRef, Option.some(inbound.level))
      } else if (inbound._tag === 'SetPermissionMode') {
        yield* modeController.applyMode(inbound.mode)
      } else if (inbound._tag === 'ResolvePlanReview') {
        const restored = yield* modeController.resolvePlan(inbound.approved)
        if (Option.isSome(restored)) {
          yield* postOutbound(PermissionModeChanged.make({ mode: restored.value }))
        }
        yield* resolveRequest(
          inbound.requestId,
          PlanReviewResponse.make({ approved: inbound.approved })
        )
      } else if (inbound._tag === 'SendText') {
        yield* restartForThinkingChange()
        yield* dropPendingRequests()
        yield* Queue.offer(promptQueue, toSDKUserMessage(inbound.text))
      } else {
        yield* resolveRequest(inbound.requestId, inbound.response)
      }
    })
  )
})

// @effect-diagnostics-next-line processEnv:off -- deliberate cross-process config channel; the parent main process sets DIA_IS_DEV (see src/main/index.ts).
const isDev = process.env.DIA_IS_DEV === '1'
// @effect-diagnostics-next-line processEnv:off -- deliberate cross-process config channel; the parent main process sets DIA_LOG_FILE (see src/main/index.ts).
const LoggerLive = makeLoggerLive(isDev, process.env.DIA_LOG_FILE ?? 'main.log')

Effect.runFork(
  Effect.scoped(program).pipe(
    Effect.provide(
      Layer.mergeAll(LoggerLive, Logger.minimumLogLevel(isDev ? LogLevel.Debug : LogLevel.Info))
    )
  )
)
