import { join } from 'node:path'
import { Data, Effect, Option, Queue, Ref, Schema, Stream } from 'effect'
import { utilityProcess } from 'electron'
import type { PaneConfig, PaneRecord } from '../domain/pane'
import type { PaneMessageAppended } from '../ipc/contract'
import { AssistantMessageReceived, InboundMessage } from '../pane-process/protocol'

export class ProcessSpawnError extends Data.TaggedError('ProcessSpawnError')<{
  readonly paneId: string
  readonly cause: unknown
}> {}

export interface PaneHandle {
  readonly sendMessage: (text: string) => Effect.Effect<void>
  readonly subscribe: () => Stream.Stream<PaneMessageAppended>
}

const encodeInbound = Schema.encodeSync(InboundMessage)
const decodeOutbound = Schema.decodeUnknownOption(AssistantMessageReceived)

const agentSessionModulePath = join(import.meta.dirname, 'pane-process/agent-session.js')

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

  const outbound = yield* Queue.unbounded<PaneMessageAppended>()
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

  const appended = decoded.pipe(
    Stream.mapEffect(({ message }) =>
      Ref.update(recordRef, (record) => ({
        ...record,
        history: [...record.history, message]
      })).pipe(Effect.as(message))
    ),
    Stream.tap((message) =>
      Effect.logInfo('Appended message to pane history', {
        paneId: config.paneId,
        role: message.role
      })
    ),
    Stream.map(
      (message): PaneMessageAppended => ({
        _tag: 'PaneMessageAppended',
        paneId: config.paneId,
        message
      })
    )
  )

  yield* Stream.runForEach(appended, (event) => Queue.offer(outbound, event)).pipe(
    Effect.forkScoped
  )

  child.postMessage(encodeInbound({ _tag: 'Init', config }))
  yield* Effect.logInfo('Sent Init message to pane process', { paneId: config.paneId })

  const handle: PaneHandle = {
    sendMessage: (text) =>
      Effect.logDebug('Sending text to pane process', { paneId: config.paneId, text }).pipe(
        Effect.andThen(
          Effect.sync(() => child.postMessage(encodeInbound({ _tag: 'SendText', text })))
        )
      ),
    subscribe: () => Stream.fromQueue(outbound)
  }

  return handle
})
