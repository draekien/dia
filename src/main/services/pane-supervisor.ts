import { join } from 'node:path'
import { Data, Effect, Option, Queue, Ref, Schema, Stream } from 'effect'
import { utilityProcess } from 'electron'
import type { PaneConfig, PaneRecord } from '../domain/pane'
import type { IpcEvent } from '../ipc/contract'
import { InboundMessage, OutboundMessage } from '../pane-process/protocol'

export class ProcessSpawnError extends Data.TaggedError('ProcessSpawnError')<{
  readonly paneId: string
  readonly cause: unknown
}> {}

export interface PaneHandle {
  readonly sendMessage: (text: string) => Effect.Effect<void>
  readonly resolvePermission: (
    requestId: string,
    decision: 'allow' | 'deny',
    message?: string
  ) => Effect.Effect<void>
  readonly subscribe: () => Stream.Stream<IpcEvent>
}

const encodeInbound = Schema.encodeSync(InboundMessage)
const decodeOutbound = Schema.decodeUnknownOption(OutboundMessage)

const agentSessionModulePath = join(import.meta.dirname, 'pane-process/agent-session.js')

function toIpcEvent(paneId: string, message: OutboundMessage): IpcEvent {
  switch (message._tag) {
    case 'AssistantMessageReceived':
      return { _tag: 'PaneMessageAppended', paneId, message: message.message }
    case 'AssistantTextDelta':
      return { _tag: 'PaneAssistantTextDelta', paneId, text: message.text }
    case 'ToolCallStarted':
      return {
        _tag: 'PaneToolCallStarted',
        paneId,
        toolCallId: message.toolCallId,
        toolName: message.toolName
      }
    case 'ToolCallCompleted':
      return {
        _tag: 'PaneToolCallCompleted',
        paneId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        input: message.input
      }
    case 'PermissionRequested':
      return {
        _tag: 'PanePermissionRequested',
        paneId,
        requestId: message.requestId,
        toolName: message.toolName,
        input: message.input
      }
  }
}

export const start = Effect.fn('PaneSupervisor.start')(function* (config: PaneConfig) {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () => utilityProcess.fork(agentSessionModulePath),
      catch: (cause) => new ProcessSpawnError({ paneId: config.paneId, cause })
    }),
    (child) =>
      Effect.logInfo('Killing pane process', { paneId: config.paneId }).pipe(
        Effect.andThen(Effect.sync(() => child.kill()))
      )
  )
  yield* Effect.logInfo('Pane process spawned', { paneId: config.paneId, pid: child.pid })

  const outbound = yield* Queue.unbounded<IpcEvent>()
  const recordRef = yield* Ref.make<PaneRecord>({ config, history: [] })

  const rawMessages = Stream.async<unknown>((emit) => {
    const listener = (raw: unknown): void => void emit.single(raw)
    child.on('message', listener)
    return Effect.sync(() => child.off('message', listener))
  })

  const decoded = rawMessages.pipe(
    Stream.mapEffect((raw) =>
      Effect.gen(function* () {
        yield* Effect.logDebug('Received raw message from pane process', {
          paneId: config.paneId,
          raw
        })
        const result = decodeOutbound(raw)
        if (Option.isNone(result)) {
          yield* Effect.logWarning('Dropped malformed message from pane process', {
            paneId: config.paneId,
            raw
          })
        }
        return result
      })
    ),
    Stream.filterMap((result) => result)
  )

  const events = decoded.pipe(
    Stream.mapEffect((message) =>
      Effect.gen(function* () {
        if (message._tag === 'AssistantMessageReceived') {
          yield* Ref.update(recordRef, (record) => ({
            ...record,
            history: [...record.history, message.message]
          }))
          yield* Effect.logInfo('Appended message to pane history', {
            paneId: config.paneId,
            role: message.message.role
          })
        }
        return toIpcEvent(config.paneId, message)
      })
    )
  )

  yield* Stream.runForEach(events, (event) => Queue.offer(outbound, event)).pipe(Effect.forkScoped)

  child.postMessage(encodeInbound({ _tag: 'Init', config }))
  yield* Effect.logInfo('Sent Init message to pane process', { paneId: config.paneId })

  const handle: PaneHandle = {
    sendMessage: (text) =>
      Effect.logDebug('Sending text to pane process', { paneId: config.paneId, text }).pipe(
        Effect.andThen(
          Effect.sync(() => child.postMessage(encodeInbound({ _tag: 'SendText', text })))
        )
      ),
    resolvePermission: (requestId, decision, message) =>
      Effect.logDebug('Sending permission resolution to pane process', {
        paneId: config.paneId,
        requestId,
        decision
      }).pipe(
        Effect.andThen(
          Effect.sync(() =>
            child.postMessage(
              encodeInbound({ _tag: 'ResolvePermission', requestId, decision, message })
            )
          )
        )
      ),
    subscribe: () => Stream.fromQueue(outbound)
  }

  return handle
})
