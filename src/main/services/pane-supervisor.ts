// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolves a static module path at import time (import.meta.dirname), outside any Effect.
import { join } from 'node:path'
import {
  Context,
  Data,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  HashMap,
  Layer,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream
} from 'effect'
import { utilityProcess } from 'electron'
import {
  type AttentionState,
  AwaitingPermission,
  ClarifyingQuestion,
  Completed,
  Errored,
  Idle,
  type PaneError,
  PermissionRequest,
  type PermissionResponse,
  type QuestionResponse,
  transitionAttention
} from '../domain/attention'
import type { PaneConfig, PaneRecord, WorktreeInfo } from '../domain/pane'
import type { PaneId } from '../domain/pane-tree'
import {
  type IpcEvent,
  PaneAssistantTextDelta,
  PaneAttentionChanged,
  PaneMessageAppended,
  PanePermissionRequested,
  PaneQuestionRequested,
  PaneToolCallCompleted,
  PaneToolCallStarted
} from '../ipc/contract'
import {
  InboundMessage,
  InitMessage,
  OutboundMessage,
  ResolvePermission,
  ResolveQuestion,
  SendText
} from '../pane-process/protocol'
import {
  GitOpsService,
  type WorktreeCreateError,
  type WorktreeReattachError
} from './git-ops-service'

/** Failure raised by {@link PaneSupervisor.openPane} when the pane's utility process could not be spawned. */
export class ProcessSpawnError extends Data.TaggedError('ProcessSpawnError')<{
  readonly paneId: string
  readonly cause: unknown
}> {}

/**
 * A pending pane's request to start running: the source directory and model the user chose,
 * plus the worktree path to provision when set (its presence is what "useWorktree" means).
 * When `resume` is set, the pane continues the prior Agent SDK session with that id, and a
 * worktree pane is reattached (its existing branch is checked out) rather than created afresh.
 * Pass to {@link PaneSupervisor.openPane} to spawn and register a new pane.
 */
export interface PaneCreationRequest {
  readonly paneId: PaneId
  readonly sourceCwd: string
  readonly model: string
  readonly worktreePath: string | undefined
  readonly resume?: string
}

/** Failure raised when a pane's process exits unexpectedly (not as part of a requested teardown). */
export class ProcessCrashedError extends Data.TaggedError('ProcessCrashedError')<{
  readonly paneId: string
  readonly exitCode: number
}> {}

/** Live control surface for an open pane, returned by {@link PaneSupervisor.openPane} and {@link PaneSupervisor.getHandle}. */
export interface PaneHandle {
  readonly sendMessage: (text: string) => Effect.Effect<void>
  readonly resolvePermission: (
    requestId: string,
    response: PermissionResponse
  ) => Effect.Effect<void>
  readonly resolveQuestion: (requestId: string, response: QuestionResponse) => Effect.Effect<void>
  readonly subscribe: () => Stream.Stream<IpcEvent>
  readonly markErrored: (error: PaneError) => Effect.Effect<void>
}

/**
 * Structural subset of Electron.UtilityProcess actually used here, so tests can
 * substitute a fake process without spawning a real one.
 */
export interface PaneProcess {
  readonly pid: number | undefined
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  off(event: 'message', listener: (message: unknown) => void): void
  postMessage(message: unknown): void
  kill(): void
}

/** Service for spawning a pane's backing process from a module path. Swap for a fake in tests. */
export class PaneProcessSpawner extends Context.Tag('PaneProcessSpawner')<
  PaneProcessSpawner,
  { readonly spawn: (modulePath: string) => Effect.Effect<PaneProcess> }
>() {}

const agentSessionModulePath = join(import.meta.dirname, 'pane-process/agent-session.js')

/** Production {@link PaneProcessSpawner} that forks the real agent-session utility process via Electron. */
export const PaneProcessSpawnerLive = Layer.succeed(PaneProcessSpawner, {
  spawn: (modulePath) => Effect.sync(() => utilityProcess.fork(modulePath))
})

const encodeInbound = Schema.encodeSync(InboundMessage)
const decodeOutbound = Schema.decodeUnknownOption(OutboundMessage)

function toIpcEvent(paneId: string, message: OutboundMessage): Option.Option<IpcEvent> {
  return Match.value(message).pipe(
    Match.tag('AssistantMessageReceived', (m) =>
      Option.some<IpcEvent>(PaneMessageAppended.make({ paneId, message: m.message }))
    ),
    Match.tag('AssistantTextDelta', (m) =>
      Option.some<IpcEvent>(PaneAssistantTextDelta.make({ paneId, text: m.text }))
    ),
    Match.tag('ToolCallStarted', (m) =>
      Option.some<IpcEvent>(
        PaneToolCallStarted.make({
          paneId,
          toolCallId: m.toolCallId,
          toolName: m.toolName
        })
      )
    ),
    Match.tag('ToolCallCompleted', (m) =>
      Option.some<IpcEvent>(
        PaneToolCallCompleted.make({
          paneId,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          input: m.input
        })
      )
    ),
    Match.tag('PermissionRequested', (m) =>
      Option.some<IpcEvent>(
        PanePermissionRequested.make({
          paneId,
          requestId: m.requestId,
          toolName: m.toolName,
          input: m.input,
          ...(m.suggestions !== undefined ? { suggestions: m.suggestions } : {})
        })
      )
    ),
    Match.tag('QuestionRequested', (m) =>
      Option.some<IpcEvent>(
        PaneQuestionRequested.make({
          paneId,
          requestId: m.requestId,
          questions: m.questions
        })
      )
    ),
    // TurnCompleted/TurnErrored/SessionStarted carry no renderer-facing content of their own --
    // they only drive AttentionState (see toAttentionTarget below) -- so they have no IpcEvent.
    Match.tag('TurnCompleted', 'TurnErrored', 'SessionStarted', () => Option.none<IpcEvent>()),
    Match.exhaustive
  )
}

function toAttentionTarget(message: OutboundMessage): Option.Option<AttentionState> {
  return Match.value(message).pipe(
    Match.tag('PermissionRequested', (m) =>
      Option.some<AttentionState>(
        AwaitingPermission.make({
          request: PermissionRequest.make({
            requestId: m.requestId,
            toolName: m.toolName,
            input: m.input
          })
        })
      )
    ),
    Match.tag('QuestionRequested', (m) =>
      Option.some<AttentionState>(
        AwaitingPermission.make({
          request: ClarifyingQuestion.make({
            requestId: m.requestId,
            questions: m.questions
          })
        })
      )
    ),
    Match.tag('TurnCompleted', () => Option.some<AttentionState>(Completed.make({}))),
    Match.tag('TurnErrored', (m) => Option.some<AttentionState>(Errored.make({ error: m.error }))),
    Match.orElse(() => Option.none<AttentionState>())
  )
}

// Deliberately doesn't know about scope ownership or crash classification --
// PaneSupervisor.openPane (the only caller) owns both, since only it knows whether
// a given process exit was requested or unexpected.
const startProcess = Effect.fn('PaneSupervisor.startProcess')(function* (
  config: PaneConfig,
  spawner: Context.Tag.Service<PaneProcessSpawner>,
  onSessionId: (sessionId: string) => Effect.Effect<void>,
  resume: string | undefined
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
  const recordRef = yield* Ref.make<PaneRecord>({
    config,
    history: [],
    attention: Idle.make({})
  })
  const settleFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<void>>>(Option.none())

  // Invalid transitions are logged and dropped rather than thrown -- a stale or duplicate
  // event (e.g. a second permission resolution) shouldn't crash the pane. Reaching `Completed`
  // schedules its own auto-settle back to `Idle` after a few seconds (per DESIGN.md's "briefly
  // shows, then settles"); any subsequent transition cancels a pending one, so a later error
  // can't be clobbered by a stale settle-to-Idle firing after the fact.
  const applyAttention: (next: AttentionState) => Effect.Effect<void> = Effect.fn(
    'PaneSupervisor.applyAttention'
  )(function* (next: AttentionState) {
    const pending = yield* Ref.get(settleFiberRef)
    if (Option.isSome(pending)) {
      yield* Fiber.interrupt(pending.value)
      yield* Ref.set(settleFiberRef, Option.none())
    }

    const record = yield* Ref.get(recordRef)
    const result = transitionAttention(record.attention, next)
    if (Either.isLeft(result)) {
      yield* Effect.logWarning('Rejected invalid attention transition', {
        paneId: config.paneId,
        from: record.attention._tag,
        to: next._tag
      })
      return
    }

    yield* Ref.update(recordRef, (r) => ({ ...r, attention: result.right }))
    yield* Queue.offer(
      outbound,
      PaneAttentionChanged.make({ paneId: config.paneId, attention: result.right })
    )

    if (result.right._tag === 'Completed') {
      const fiber = yield* Effect.sleep(Duration.seconds(3)).pipe(
        // Clear settleFiberRef before recursing into applyAttention(Idle) -- otherwise this
        // fiber reads its own reference back out of the Ref and interrupts itself mid-flight,
        // aborting before it can ever apply the Idle transition (see reasoning log).
        Effect.andThen(Ref.set(settleFiberRef, Option.none())),
        Effect.andThen(applyAttention(Idle.make({}))),
        Effect.fork
      )
      yield* Ref.set(settleFiberRef, Option.some(fiber))
    }
  })

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

  const handleInbound = (message: OutboundMessage): Effect.Effect<void> =>
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

      if (message._tag === 'SessionStarted') {
        yield* Effect.logInfo('Pane session started', {
          paneId: config.paneId,
          sessionId: message.sessionId
        })
        yield* onSessionId(message.sessionId)
      }

      const event = toIpcEvent(config.paneId, message)
      if (Option.isSome(event)) yield* Queue.offer(outbound, event.value)

      const attentionTarget = toAttentionTarget(message)
      if (Option.isSome(attentionTarget)) yield* applyAttention(attentionTarget.value)
    })

  yield* Stream.runForEach(decoded, handleInbound).pipe(Effect.forkScoped)

  child.postMessage(encodeInbound(InitMessage.make({ config, resume })))
  yield* Effect.logInfo('Sent Init message to pane process', { paneId: config.paneId, resume })

  const exits = Stream.async<number>((emit) => {
    const listener = (code: number): void => void emit.single(code)
    child.on('exit', listener)
    return Effect.void
  })

  const handle: PaneHandle = {
    sendMessage: (text) =>
      Effect.logDebug('Sending text to pane process', { paneId: config.paneId, text }).pipe(
        Effect.andThen(Effect.sync(() => child.postMessage(encodeInbound(SendText.make({ text })))))
      ),
    resolvePermission: (requestId, response) =>
      Effect.logDebug('Sending permission resolution to pane process', {
        paneId: config.paneId,
        requestId,
        decision: response._tag
      }).pipe(
        Effect.andThen(
          Effect.sync(() =>
            child.postMessage(encodeInbound(ResolvePermission.make({ requestId, response })))
          )
        ),
        Effect.andThen(applyAttention(Idle.make({})))
      ),
    resolveQuestion: (requestId, response) =>
      Effect.logDebug('Sending question resolution to pane process', {
        paneId: config.paneId,
        requestId,
        kind: response._tag
      }).pipe(
        Effect.andThen(
          Effect.sync(() =>
            child.postMessage(encodeInbound(ResolveQuestion.make({ requestId, response })))
          )
        ),
        Effect.andThen(applyAttention(Idle.make({})))
      ),
    subscribe: () => Stream.fromQueue(outbound),
    markErrored: (error) => applyAttention(Errored.make({ error }))
  }

  return { handle, exits }
})

interface PaneEntry {
  readonly handle: PaneHandle
  readonly scope: Scope.CloseableScope
  readonly expectedExit: Ref.Ref<boolean>
}

/** Manages the lifecycle of all open panes: spawning, event routing, and teardown. */
export class PaneSupervisor extends Context.Tag('PaneSupervisor')<
  PaneSupervisor,
  {
    /**
     * Provisions a pane's worktree (creating it, or reattaching the existing branch when
     * `request.resume` is set), spawns its process, and registers it for lookup and teardown.
     * `onSessionId` is invoked when the pane's Agent SDK session starts or resumes, carrying the
     * id the caller should persist for later resume.
     */
    readonly openPane: (
      request: PaneCreationRequest,
      onEvent: (event: IpcEvent) => Effect.Effect<void>,
      onSessionId: (sessionId: string) => Effect.Effect<void>
    ) => Effect.Effect<
      { readonly handle: PaneHandle; readonly config: PaneConfig },
      ProcessSpawnError | WorktreeCreateError | WorktreeReattachError
    >
    /** Kills the given pane's process and removes its worktree, marking the exit as expected. */
    readonly closePane: (paneId: PaneId) => Effect.Effect<void>
    /** Looks up the live {@link PaneHandle} for an open pane, if any. */
    readonly getHandle: (paneId: PaneId) => Effect.Effect<Option.Option<PaneHandle>>
    /**
     * Gracefully tears down every open pane (killing its process and removing its worktree, if
     * any) -- for app shutdown, so panes are never left to be killed out-of-band and misreported
     * as crashes.
     */
    readonly closeAll: () => Effect.Effect<void>
  }
>() {}

/** Production {@link PaneSupervisor} layer backed by real utility processes and git worktrees. */
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
      onEvent: (event: IpcEvent) => Effect.Effect<void>,
      onSessionId: (sessionId: string) => Effect.Effect<void>
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

        // On resume the worktree was removed on the prior graceful shutdown but its branch
        // persists, so reattach (check out the existing branch) rather than create a new one --
        // creating would fail on the already-existing `dia/<paneId>` branch.
        const acquire: Effect.Effect<WorktreeInfo, WorktreeCreateError | WorktreeReattachError> =
          request.resume === undefined
            ? gitOps.createWorktree(request.sourceCwd, request.paneId, request.worktreePath)
            : gitOps.reattachWorktree(
                {
                  path: request.worktreePath,
                  branch: `dia/${request.paneId}`,
                  sourceRepo: request.sourceCwd
                },
                request.paneId
              )

        const worktree = yield* Effect.acquireRelease(acquire, (info) =>
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
        return yield* prepared.left
      }

      const config = prepared.right

      const started = yield* startProcess(config, spawner, onSessionId, request.resume).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.either
      )

      if (Either.isLeft(started)) {
        yield* Scope.close(scope, Exit.fail(started.left))
        return yield* started.left
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
                  ).pipe(
                    Effect.andThen(
                      handle.markErrored({
                        message: `Pane process exited unexpectedly (code ${exitCode})`
                      })
                    ),
                    Effect.andThen(teardown(config.paneId))
                  )
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
