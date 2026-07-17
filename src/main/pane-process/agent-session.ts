import {
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  Data,
  Deferred,
  Effect,
  Either,
  Layer,
  Logger,
  LogLevel,
  Match,
  Queue,
  Schema,
  Stream
} from 'effect'
import { Question, type QuestionResponse } from '../domain/attention'
import type { PaneConfig } from '../domain/pane'
import { makeLoggerLive } from '../logger'
import { makeSessionEventReducer } from './agent-session-reducer'
import { makePendingUserInput, type UserInputResolution } from './pending-user-input'
import { InboundMessage, OutboundMessage } from './protocol'

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
    Match.exhaustive
  )

const canUseTool: CanUseTool = (toolName, input, options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const deferred = yield* pendingUserInput.register(options.toolUseID)

      const questions =
        toolName === 'AskUserQuestion' ? decodeQuestions(input.questions) : undefined
      if (questions !== undefined && Either.isRight(questions)) {
        yield* postOutbound({
          _tag: 'QuestionRequested',
          requestId: options.toolUseID,
          questions: questions.right
        })
      } else {
        if (questions !== undefined) {
          yield* Effect.logWarning(
            'AskUserQuestion input did not match the Question schema; surfacing it as a permission request',
            { requestId: options.toolUseID, issue: questions.left }
          )
        }
        yield* postOutbound({
          _tag: 'PermissionRequested',
          requestId: options.toolUseID,
          toolName,
          input,
          suggestions: options.suggestions
        })
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

const toSDKUserMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null
})

const runSession = Effect.fn('AgentSession.runSession')(
  function* (
    config: PaneConfig,
    promptQueue: Queue.Queue<SDKUserMessage>,
    resume: string | undefined
  ) {
    yield* Effect.logInfo('Starting query session', {
      paneId: config.paneId,
      cwd: config.cwd,
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
        resume
      }
    })

    const events = Stream.fromAsyncIterable(session, (cause) => new SessionStreamError({ cause }))
    const reducer = makeSessionEventReducer()

    yield* Stream.runForEach(events, (event) =>
      Effect.forEach(reducer.step(event), (outbound) =>
        Effect.gen(function* () {
          if (outbound._tag === 'ToolCallStarted') {
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
      Effect.catchAllCause((cause) =>
        Effect.logError('Agent session failed', { paneId: config.paneId, cause })
      )
    )
)

const program = Effect.gen(function* () {
  const promptQueue = yield* Queue.unbounded<SDKUserMessage>()

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
        yield* Effect.forkScoped(runSession(inbound.config, promptQueue, inbound.resume))
      } else if (inbound._tag === 'SendText') {
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
