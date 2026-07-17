import {
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { Data, Deferred, Effect, Either, Logger, LogLevel, Queue, Schema, Stream } from 'effect'
import { type PermissionResponse, Question, type QuestionResponse } from '../domain/attention'
import type { ConversationMessage, PaneConfig } from '../domain/pane'
import { makeLoggerLive } from '../logger'
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

type UserInputResolution = PermissionResponse | QuestionResponse

const pendingRequests = new Map<string, Deferred.Deferred<UserInputResolution>>()

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
): PermissionResult => {
  switch (resolution._tag) {
    case 'Deny':
      return { behavior: 'deny', message: resolution.message }
    case 'Allow':
      return {
        behavior: 'allow',
        ...(resolution.updatedInput !== undefined
          ? { updatedInput: { ...resolution.updatedInput } }
          : {}),
        ...(suggestions !== undefined &&
        resolution.updatedPermissions !== undefined &&
        resolution.updatedPermissions.length > 0
          ? { updatedPermissions: suggestions }
          : {})
      }
    case 'Answers':
    case 'FreeformResponse':
      return questionResponseToResult(resolution)
  }
}

const canUseTool: CanUseTool = (toolName, input, options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<UserInputResolution>()
      pendingRequests.set(options.toolUseID, deferred)

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
      pendingRequests.delete(options.toolUseID)
      return toPermissionResult(resolution, options.suggestions)
    })
  )

const resolveRequest = (requestId: string, resolution: UserInputResolution): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deferred = pendingRequests.get(requestId)
    if (!deferred) {
      yield* Effect.logWarning('Received a resolution for an unknown requestId', { requestId })
      return
    }
    yield* Deferred.succeed(deferred, resolution)
  })

const dropPendingRequests: Effect.Effect<void> = Effect.gen(function* () {
  if (pendingRequests.size === 0) return
  const requestIds = [...pendingRequests.keys()]
  pendingRequests.clear()
  yield* Effect.logInfo('Redirected pane; dropping pending user-input requests', { requestIds })
})

const toSDKUserMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null
})

const parseToolInput = (partialJson: string): Record<string, unknown> => {
  try {
    return partialJson ? JSON.parse(partialJson) : {}
  } catch {
    return {}
  }
}

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

    const toolCallsByBlockIndex = new Map<number, { id: string; name: string }>()
    const partialJsonByBlockIndex = new Map<number, string>()

    yield* Stream.runForEach(events, (event) =>
      Effect.gen(function* () {
        if (event.type === 'system' && event.subtype === 'init') {
          yield* postOutbound({ _tag: 'SessionStarted', sessionId: event.session_id })
          return
        }

        if (event.type === 'assistant') {
          const text = event.message.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('')
          if (text) {
            const message: ConversationMessage = { role: 'assistant', content: text }
            yield* postOutbound({ _tag: 'AssistantMessageReceived', message })
          }
          return
        }

        if (event.type === 'result') {
          if (event.subtype === 'success') {
            yield* postOutbound({ _tag: 'TurnCompleted' })
          } else {
            const message = event.errors.length > 0 ? event.errors.join('; ') : event.subtype
            yield* postOutbound({ _tag: 'TurnErrored', error: { message } })
          }
          return
        }

        if (event.type !== 'stream_event') return
        const streamEvent = event.event

        if (
          streamEvent.type === 'content_block_start' &&
          streamEvent.content_block.type === 'tool_use'
        ) {
          const { id, name } = streamEvent.content_block
          toolCallsByBlockIndex.set(streamEvent.index, { id, name })
          partialJsonByBlockIndex.set(streamEvent.index, '')
          yield* postOutbound({ _tag: 'ToolCallStarted', toolCallId: id, toolName: name })
          return
        }

        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            yield* postOutbound({ _tag: 'AssistantTextDelta', text: streamEvent.delta.text })
          } else if (streamEvent.delta.type === 'input_json_delta') {
            const existing = partialJsonByBlockIndex.get(streamEvent.index) ?? ''
            partialJsonByBlockIndex.set(
              streamEvent.index,
              existing + streamEvent.delta.partial_json
            )
          }
          return
        }

        if (streamEvent.type === 'content_block_stop') {
          const toolCall = toolCallsByBlockIndex.get(streamEvent.index)
          if (!toolCall) return
          const partialJson = partialJsonByBlockIndex.get(streamEvent.index) ?? ''
          toolCallsByBlockIndex.delete(streamEvent.index)
          partialJsonByBlockIndex.delete(streamEvent.index)

          yield* postOutbound({
            _tag: 'ToolCallCompleted',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: parseToolInput(partialJson)
          })
        }
      })
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
        yield* dropPendingRequests
        yield* Queue.offer(promptQueue, toSDKUserMessage(inbound.text))
      } else {
        yield* resolveRequest(inbound.requestId, inbound.response)
      }
    })
  )
})

const isDev = process.env.DIA_IS_DEV === '1'
const LoggerLive = makeLoggerLive(isDev, process.env.DIA_LOG_FILE ?? 'main.log')

Effect.runFork(
  Effect.scoped(program).pipe(
    Effect.provide(LoggerLive),
    Effect.provide(Logger.minimumLogLevel(isDev ? LogLevel.Debug : LogLevel.Info))
  )
)
