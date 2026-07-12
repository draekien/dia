import { join } from 'node:path'
import {
  Context,
  Data,
  Duration,
  Effect,
  Either,
  Exit,
  HashMap,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream
} from 'effect'
import { utilityProcess } from 'electron'
import type { PaneConfig, PaneRecord } from '../domain/pane'
import type { PaneId } from '../domain/pane-tree'
import type { IpcEvent } from '../ipc/contract'
import { InboundMessage, OutboundMessage } from '../pane-process/protocol'
import { GitOpsService, type WorktreeCreateError } from './git-ops-service'

export class ProcessSpawnError extends Data.TaggedError('ProcessSpawnError')<{
  readonly paneId: string
  readonly cause: unknown
}> {}

// A pending pane's request to start running: the source directory and model the user chose,
// plus the worktree path to provision when set (its presence is what "useWorktree" means).
export interface PaneCreationRequest {
  readonly paneId: PaneId
  readonly sourceCwd: string
  readonly model: string
  readonly worktreePath: string | undefined
}

export class ProcessCrashedError extends Data.TaggedError('ProcessCrashedError')<{
  readonly paneId: string
  readonly exitCode: number
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

// Structural subset of Electron.UtilityProcess actually used here, so tests can
// substitute a fake process without spawning a real one.
export interface PaneProcess {
  readonly pid: number | undefined
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  off(event: 'message', listener: (message: unknown) => void): void
  postMessage(message: unknown): void
  kill(): void
}

export class PaneProcessSpawner extends Context.Tag('PaneProcessSpawner')<
  PaneProcessSpawner,
  { readonly spawn: (modulePath: string) => Effect.Effect<PaneProcess> }
>() {}

const agentSessionModulePath = join(import.meta.dirname, 'pane-process/agent-session.js')

export const PaneProcessSpawnerLive = Layer.succeed(PaneProcessSpawner, {
  spawn: (modulePath) => Effect.sync(() => utilityProcess.fork(modulePath))
})

const encodeInbound = Schema.encodeSync(InboundMessage)
const decodeOutbound = Schema.decodeUnknownOption(OutboundMessage)

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

// Spawns the pane's process and builds its handle. Deliberately doesn't know about scope
// ownership or crash classification -- PaneSupervisor.openPane (the only caller) owns both,
// since only it knows whether a given process exit was requested or unexpected.
const startProcess = Effect.fn('PaneSupervisor.startProcess')(function* (
  config: PaneConfig,
  spawner: Context.Tag.Service<PaneProcessSpawner>
) {
  const child = yield* Effect.acquireRelease(
    spawner
      .spawn(agentSessionModulePath)
      .pipe(Effect.mapError((cause) => new ProcessSpawnError({ paneId: config.paneId, cause }))),
    (child) =>
      Effect.gen(function* () {
        yield* Effect.logInfo('Killing pane process', { paneId: config.paneId })
        // Wait for the OS process to actually exit (not just for kill() to be called) before
        // this finalizer resolves -- a worktree-remove finalizer may run right after this one,
        // and on Windows `git worktree remove` fails while the killed process still holds the
        // worktree directory as its cwd/open handles.
        // Register the exit listener and call kill() inside the same synchronous callback --
        // a listener attached only after kill() can miss a synchronous 'exit' emission.
        const exited = Effect.async<void>((resume) => {
          child.on('exit', () => resume(Effect.void))
          child.kill()
        })
        yield* exited.pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.catchAll(() =>
            Effect.logWarning('Pane process did not exit within timeout', {
              paneId: config.paneId
            })
          )
        )
      })
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

  const exits = Stream.async<number>((emit) => {
    const listener = (code: number): void => void emit.single(code)
    child.on('exit', listener)
    return Effect.void
  })

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

  return { handle, exits }
})

interface PaneEntry {
  readonly handle: PaneHandle
  readonly scope: Scope.CloseableScope
  readonly expectedExit: Ref.Ref<boolean>
}

export class PaneSupervisor extends Context.Tag('PaneSupervisor')<
  PaneSupervisor,
  {
    readonly openPane: (
      request: PaneCreationRequest,
      onEvent: (event: IpcEvent) => Effect.Effect<void>
    ) => Effect.Effect<
      { readonly handle: PaneHandle; readonly config: PaneConfig },
      ProcessSpawnError | WorktreeCreateError
    >
    readonly closePane: (paneId: PaneId) => Effect.Effect<void>
    readonly getHandle: (paneId: PaneId) => Effect.Effect<Option.Option<PaneHandle>>
    // Gracefully tears down every open pane (killing its process and removing its worktree, if
    // any) -- for app shutdown, so panes are never left to be killed out-of-band and misreported
    // as crashes.
    readonly closeAll: () => Effect.Effect<void>
  }
>() {}

export const PaneSupervisorLive = Layer.effect(
  PaneSupervisor,
  Effect.gen(function* () {
    const spawner = yield* PaneProcessSpawner
    const gitOps = yield* GitOpsService
    const entriesRef = yield* Ref.make(HashMap.empty<PaneId, PaneEntry>())

    const teardown = Effect.fn('PaneSupervisor.teardown')(function* (paneId: PaneId) {
      const entries = yield* Ref.get(entriesRef)
      const entry = HashMap.get(entries, paneId)
      if (Option.isNone(entry)) return
      yield* Ref.set(entry.value.expectedExit, true)
      yield* Ref.update(entriesRef, HashMap.remove(paneId))
      yield* Scope.close(entry.value.scope, Exit.succeed(undefined))
    })

    const openPane = Effect.fn('PaneSupervisor.openPane')(function* (
      request: PaneCreationRequest,
      onEvent: (event: IpcEvent) => Effect.Effect<void>
    ) {
      const scope = yield* Scope.make()
      const expectedExit = yield* Ref.make(false)

      const prepared = yield* Effect.gen(function* () {
        if (request.worktreePath === undefined) {
          const config: PaneConfig = {
            paneId: request.paneId,
            cwd: request.sourceCwd,
            model: request.model
          }
          return config
        }

        const worktree = yield* Effect.acquireRelease(
          gitOps.createWorktree(request.sourceCwd, request.paneId, request.worktreePath),
          (info) =>
            gitOps.removeWorktree(info, request.paneId).pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError('Failed to remove pane worktree', {
                  paneId: request.paneId,
                  cause
                })
              )
            )
        )

        const config: PaneConfig = {
          paneId: request.paneId,
          cwd: worktree.path,
          model: request.model,
          worktree
        }
        return config
      }).pipe(Effect.provideService(Scope.Scope, scope), Effect.either)

      if (Either.isLeft(prepared)) {
        yield* Scope.close(scope, Exit.fail(prepared.left))
        return yield* Effect.fail(prepared.left)
      }

      const config = prepared.right

      const started = yield* startProcess(config, spawner).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.either
      )

      if (Either.isLeft(started)) {
        yield* Scope.close(scope, Exit.fail(started.left))
        return yield* Effect.fail(started.left)
      }

      const { handle, exits } = started.right

      yield* Effect.forkIn(Stream.runForEach(handle.subscribe(), onEvent), scope)
      yield* Effect.forkIn(
        Stream.runForEach(exits, (exitCode) =>
          Ref.get(expectedExit).pipe(
            Effect.flatMap((expected) =>
              expected
                ? Effect.void
                : Effect.logError(
                    new ProcessCrashedError({ paneId: config.paneId, exitCode })
                  ).pipe(Effect.andThen(teardown(config.paneId)))
            )
          )
        ),
        scope
      )

      yield* Ref.update(entriesRef, HashMap.set(config.paneId, { handle, scope, expectedExit }))
      return { handle, config }
    })

    const closePane = (paneId: PaneId) => teardown(paneId)

    const getHandle = (paneId: PaneId) =>
      Ref.get(entriesRef).pipe(
        Effect.map((entries) => Option.map(HashMap.get(entries, paneId), (entry) => entry.handle))
      )

    const closeAll = () =>
      Ref.get(entriesRef).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(Array.from(HashMap.keys(entries)), teardown, { discard: true })
        )
      )

    return { openPane, closePane, getHandle, closeAll }
  })
)
