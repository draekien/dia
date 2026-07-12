import { utilityProcess } from 'electron'
import { Data, Effect, Option, Queue, Ref, Runtime, Schema, type Scope, Stream } from 'effect'
import { join } from 'node:path'
import type { PaneConfig, PaneRecord } from '../domain/pane'
import { PaneMessageAppended } from '../ipc/contract'
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

export const start = (config: PaneConfig): Effect.Effect<PaneHandle, ProcessSpawnError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => utilityProcess.fork(agentSessionModulePath),
      catch: (cause) => new ProcessSpawnError({ paneId: config.paneId, cause })
    }),
    (child) =>
      Effect.logInfo('Killing pane process', { paneId: config.paneId }).pipe(
        Effect.andThen(Effect.sync(() => child.kill()))
      )
  ).pipe(
    Effect.tap((child) => Effect.logInfo('Pane process spawned', { paneId: config.paneId, pid: child.pid })),
    Effect.flatMap((child) =>
      Effect.gen(function* () {
        const outbound = yield* Queue.unbounded<PaneMessageAppended>()
        const recordRef = yield* Ref.make<PaneRecord>({ config, history: [] })
        const runtime = yield* Effect.runtime<never>()
        const runSync = Runtime.runSync(runtime)

        child.on('message', (raw) => {
          runSync(
            Effect.gen(function* () {
              yield* Effect.logDebug('Received raw message from pane process', { paneId: config.paneId, raw })
              const decoded = decodeOutbound(raw)
              if (Option.isNone(decoded)) {
                yield* Effect.logWarning('Dropped malformed message from pane process', {
                  paneId: config.paneId,
                  raw
                })
                return
              }

              const message = decoded.value.message
              yield* Ref.update(recordRef, (record) => ({ ...record, history: [...record.history, message] }))
              yield* Queue.offer(outbound, {
                _tag: 'PaneMessageAppended',
                paneId: config.paneId,
                message
              })
              yield* Effect.logInfo('Appended message to pane history', { paneId: config.paneId, role: message.role })
            })
          )
        })

        child.postMessage(encodeInbound({ _tag: 'Init', config }))
        yield* Effect.logInfo('Sent Init message to pane process', { paneId: config.paneId })

        const handle: PaneHandle = {
          sendMessage: (text) =>
            Effect.logDebug('Sending text to pane process', { paneId: config.paneId, text }).pipe(
              Effect.andThen(Effect.sync(() => child.postMessage(encodeInbound({ _tag: 'SendText', text }))))
            ),
          subscribe: () => Stream.fromQueue(outbound)
        }

        return handle
      })
    )
  )
