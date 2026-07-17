import { EventEmitter } from 'node:events'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Logger, Option, TestClock } from 'effect'
import type { PaneConfig, WorktreeInfo } from '../domain/pane'
import type { IpcEvent } from '../ipc/contract'
import { GitOpsService } from './git-ops-service'
import {
  type PaneCreationRequest,
  type PaneProcess,
  PaneProcessSpawner,
  PaneSupervisor,
  PaneSupervisorLive,
  ProcessCrashedError
} from './pane-supervisor'

class FakePaneProcess extends EventEmitter implements PaneProcess {
  readonly pid = 4242
  readonly posted: unknown[] = []

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  kill(): void {
    this.emit('exit', 0)
  }
}

const requestA: PaneCreationRequest = {
  paneId: 'aaaaaaaa-0000-4000-8000-000000000001',
  sourceCwd: '/a',
  model: 'm',
  worktreePath: undefined
}
const requestB: PaneCreationRequest = {
  paneId: 'bbbbbbbb-0000-4000-8000-000000000002',
  sourceCwd: '/b',
  model: 'm',
  worktreePath: undefined
}

const configA: PaneConfig = {
  paneId: requestA.paneId,
  cwd: requestA.sourceCwd,
  model: requestA.model
}
const configB: PaneConfig = {
  paneId: requestB.paneId,
  cwd: requestB.sourceCwd,
  model: requestB.model
}

// Runs the fiber-scheduler forward without touching the (virtualized) Clock, so a
// synchronous EventEmitter.emit has a chance to reach the fiber consuming the exits Stream.
const flush = Effect.repeatN(Effect.yieldNow(), 50)

const ignoreSessionId = (_sessionId: string): Effect.Effect<void> => Effect.void

function makeTestSetup(): {
  readonly processes: ReadonlyArray<FakePaneProcess>
  readonly capturedLogs: ReadonlyArray<unknown>
  readonly testLayer: Layer.Layer<PaneSupervisor>
  readonly loggerLayer: Layer.Layer<never>
} {
  const processes: FakePaneProcess[] = []
  const spawnerLayer = Layer.succeed(PaneProcessSpawner, {
    spawn: () =>
      Effect.sync(() => {
        const process = new FakePaneProcess()
        processes.push(process)
        return process
      })
  })

  const gitOpsLayer = Layer.succeed(GitOpsService, {
    createWorktree: () => Effect.dieMessage('createWorktree should not be called in these tests'),
    removeWorktree: () => Effect.dieMessage('removeWorktree should not be called in these tests'),
    reattachWorktree: () =>
      Effect.dieMessage('reattachWorktree should not be called in these tests')
  })

  const capturedLogs: unknown[] = []
  const captureLogger = Logger.make(({ message }) => {
    capturedLogs.push(...(Array.isArray(message) ? message : [message]))
  })

  const testLayer = Layer.provide(PaneSupervisorLive, Layer.merge(spawnerLayer, gitOpsLayer))
  const loggerLayer = Logger.add(captureLogger)

  return { processes, capturedLogs, testLayer, loggerLayer }
}

describe('PaneSupervisor', () => {
  it.effect('removes a pane that crashes unexpectedly, leaving its sibling alive', () =>
    Effect.gen(function* () {
      const { processes, capturedLogs, testLayer, loggerLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const eventsA: IpcEvent[] = []
        const eventsB: IpcEvent[] = []

        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => eventsA.push(event)),
          ignoreSessionId
        )
        const openedB = yield* supervisor.openPane(
          requestB,
          (event) => Effect.sync(() => eventsB.push(event)),
          ignoreSessionId
        )
        const handleB = openedB.handle

        // openPane forks the exit listener registration; give it a chance to
        // actually attach before emitting, since a synchronous EventEmitter.emit
        // with no listener yet attached is silently dropped, not queued.
        yield* flush

        processes[0].emit('exit', 1)
        yield* flush

        const afterCrashA = yield* supervisor.getHandle(configA.paneId)
        assert.isTrue(Option.isNone(afterCrashA))

        const afterCrashB = yield* supervisor.getHandle(configB.paneId)
        assert.isTrue(Option.isSome(afterCrashB))

        // Prove B is still functionally alive, not just present in the map.
        processes[1].emit('message', {
          _tag: 'AssistantMessageReceived',
          message: { role: 'assistant', content: 'still alive' }
        })
        yield* flush
        yield* handleB.sendMessage('ping')
        assert.deepStrictEqual(processes[1].posted, [
          { _tag: 'Init', config: configB, resume: undefined },
          { _tag: 'SendText', text: 'ping' }
        ])
        assert.deepStrictEqual(eventsB, [
          {
            _tag: 'PaneMessageAppended',
            paneId: configB.paneId,
            message: { role: 'assistant', content: 'still alive' }
          }
        ])

        assert.isTrue(
          capturedLogs.some(
            (log) =>
              log instanceof ProcessCrashedError &&
              log.paneId === configA.paneId &&
              log.exitCode === 1
          )
        )

        // Before being torn down, the crashed pane's attention transitions to Errored so the
        // renderer can still show a red pulse for it.
        assert.isTrue(
          eventsA.some(
            (event) => event._tag === 'PaneAttentionChanged' && event.attention._tag === 'Errored'
          )
        )
      }).pipe(Effect.scoped, Effect.provide(testLayer), Effect.provide(loggerLayer))
    })
  )

  it.effect('does not misreport an intentional closePane as a crash', () =>
    Effect.gen(function* () {
      const { processes, capturedLogs, testLayer, loggerLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor

        yield* supervisor.openPane(requestA, () => Effect.void, ignoreSessionId)
        yield* supervisor.openPane(requestB, () => Effect.void, ignoreSessionId)

        yield* supervisor.closePane(configA.paneId)
        yield* flush

        const afterCloseA = yield* supervisor.getHandle(configA.paneId)
        assert.isTrue(Option.isNone(afterCloseA))

        const afterCloseB = yield* supervisor.getHandle(configB.paneId)
        assert.isTrue(Option.isSome(afterCloseB))

        assert.isTrue(processes[0].posted.length > 0)
        assert.isFalse(capturedLogs.some((log) => log instanceof ProcessCrashedError))
      }).pipe(Effect.scoped, Effect.provide(testLayer), Effect.provide(loggerLayer))
    })
  )

  it.effect('routes a SessionStarted message from the pane to the onSessionId callback', () =>
    Effect.gen(function* () {
      const { processes, testLayer, loggerLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const sessionIds: string[] = []

        yield* supervisor.openPane(
          requestA,
          () => Effect.void,
          (sessionId) => Effect.sync(() => sessionIds.push(sessionId))
        )
        yield* flush

        processes[0].emit('message', { _tag: 'SessionStarted', sessionId: 'session-xyz' })
        yield* flush

        assert.deepStrictEqual(sessionIds, ['session-xyz'])
      }).pipe(Effect.scoped, Effect.provide(testLayer), Effect.provide(loggerLayer))
    })
  )

  it.effect('resuming a worktree pane reattaches its branch and threads resume into Init', () =>
    Effect.gen(function* () {
      const processes: FakePaneProcess[] = []
      const spawnerLayer = Layer.succeed(PaneProcessSpawner, {
        spawn: () =>
          Effect.sync(() => {
            const process = new FakePaneProcess()
            processes.push(process)
            return process
          })
      })
      const reattachCalls: Array<{ info: WorktreeInfo; paneId: string }> = []
      const gitOpsLayer = Layer.succeed(GitOpsService, {
        createWorktree: () => Effect.dieMessage('createWorktree must not be called when resuming'),
        removeWorktree: () => Effect.void,
        reattachWorktree: (info, paneId) =>
          Effect.sync(() => {
            reattachCalls.push({ info, paneId })
            return info
          })
      })
      const testLayer = Layer.provide(PaneSupervisorLive, Layer.merge(spawnerLayer, gitOpsLayer))

      const resumeRequest: PaneCreationRequest = {
        paneId: 'cccccccc-0000-4000-8000-000000000003',
        sourceCwd: '/repo',
        model: 'm',
        worktreePath: '/wt/c',
        resume: 'session-resume-1'
      }
      const expectedInfo: WorktreeInfo = {
        path: '/wt/c',
        branch: `dia/${resumeRequest.paneId}`,
        sourceRepo: '/repo'
      }

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const opened = yield* supervisor.openPane(resumeRequest, () => Effect.void, ignoreSessionId)
        yield* flush

        assert.deepStrictEqual(reattachCalls, [
          { info: expectedInfo, paneId: resumeRequest.paneId }
        ])
        assert.strictEqual(opened.config.cwd, '/wt/c')
        assert.deepStrictEqual(processes[0].posted[0], {
          _tag: 'Init',
          config: {
            paneId: resumeRequest.paneId,
            cwd: '/wt/c',
            model: 'm',
            worktree: expectedInfo
          },
          resume: 'session-resume-1'
        })
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('auto-settles Completed back to Idle after 3 seconds', () =>
    Effect.gen(function* () {
      const { processes, testLayer, loggerLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const events: IpcEvent[] = []

        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => events.push(event)),
          ignoreSessionId
        )
        yield* flush

        processes[0].emit('message', { _tag: 'TurnCompleted' })
        yield* flush

        assert.isTrue(
          events.some(
            (event) => event._tag === 'PaneAttentionChanged' && event.attention._tag === 'Completed'
          )
        )

        yield* TestClock.adjust('3 seconds')
        yield* flush

        assert.isTrue(
          events.some(
            (event) => event._tag === 'PaneAttentionChanged' && event.attention._tag === 'Idle'
          )
        )
      }).pipe(Effect.scoped, Effect.provide(testLayer), Effect.provide(loggerLayer))
    })
  )
})
