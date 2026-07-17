import {
  type CanUseTool,
  type PermissionResult,
  query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { Data, Deferred, Effect, Either, Logger, LogLevel, Queue, Schema, Stream } from 'effect'
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

const pendingPermissions = new Map<string, Deferred.Deferred<PermissionResult>>()

const canUseTool: CanUseTool = (toolName, input, options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<PermissionResult>()
      pendingPermissions.set(options.toolUseID, deferred)
      yield* postOutbound({
        _tag: 'PermissionRequested',
        requestId: options.toolUseID,
        toolName,
        input
      })
      const result = yield* Deferred.await(deferred)
      pendingPermissions.delete(options.toolUseID)
      return result
    })
  )

const resolvePermission = (
  requestId: string,
  decision: 'allow' | 'deny',
  message: string | undefined
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deferred = pendingPermissions.get(requestId)
    if (!deferred) {
      yield* Effect.logWarning('Received ResolvePermission for unknown requestId', { requestId })
      return
    }
    const result: PermissionResult =
      decision === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: message ?? 'Permission denied' }
    yield* Deferred.succeed(deferred, result)
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
        yield* Queue.offer(promptQueue, toSDKUserMessage(inbound.text))
      } else {
        yield* resolvePermission(inbound.requestId, inbound.decision, inbound.message)
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
