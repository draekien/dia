import { type Command, CommandExecutor } from '@effect/platform'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Either, Layer, Logger } from 'effect'
import type { WorktreeInfo } from '../domain/pane'
import { GitOpsService, GitOpsServiceLive, WorktreeCreateError } from './git-ops-service'

const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function makeFakeExecutor(
  exitCodeFor: (command: Command.Command) => number
): CommandExecutor.CommandExecutor {
  return {
    exitCode: (command: Command.Command) =>
      Effect.succeed(exitCodeFor(command) as CommandExecutor.ExitCode)
  } as unknown as CommandExecutor.CommandExecutor
}

function makeTestSetup(exitCodeFor: (command: Command.Command) => number): {
  readonly capturedLogs: ReadonlyArray<unknown>
  readonly testLayer: Layer.Layer<GitOpsService>
  readonly loggerLayer: Layer.Layer<never>
} {
  const executorLayer = Layer.succeed(
    CommandExecutor.CommandExecutor,
    makeFakeExecutor(exitCodeFor)
  )

  const capturedLogs: unknown[] = []
  const captureLogger = Logger.make(({ message }) => {
    capturedLogs.push(...(Array.isArray(message) ? message : [message]))
  })

  const testLayer = Layer.provide(GitOpsServiceLive, executorLayer)
  const loggerLayer = Logger.add(captureLogger)

  return { capturedLogs, testLayer, loggerLayer }
}

describe('GitOpsService', () => {
  it.effect('createWorktree returns a WorktreeInfo on success', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(() => 0)

      const info = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.createWorktree('/repo', PANE_ID, '/repo/.dia/worktrees/pane-1')
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(info, {
        path: '/repo/.dia/worktrees/pane-1',
        branch: `dia/${PANE_ID}`,
        sourceRepo: '/repo'
      })
    })
  )

  it.effect('createWorktree fails with WorktreeCreateError on non-zero exit', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(() => 1)

      const result = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.createWorktree('/repo', PANE_ID, '/repo/.dia/worktrees/pane-1')
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer), Effect.either)

      assert.isTrue(Either.isLeft(result))
      if (Either.isLeft(result)) {
        assert.instanceOf(result.left, WorktreeCreateError)
      }
    })
  )

  it.effect('removeWorktree succeeds on a zero exit', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(() => 0)
      const info: WorktreeInfo = {
        path: '/repo/.dia/worktrees/pane-1',
        branch: `dia/${PANE_ID}`,
        sourceRepo: '/repo'
      }

      yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        yield* gitOps.removeWorktree(info, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))
    })
  )

  it.effect('removeWorktree tries prune as fallback when remove fails', () =>
    Effect.gen(function* () {
      // Create executor that tracks invocation count: first call fails, second (prune) succeeds
      let commandCount = 0
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup(() => {
        commandCount++
        // First command (remove) returns 1, second (prune) returns 0
        return commandCount === 1 ? 1 : 0
      })
      const info: WorktreeInfo = {
        path: '/repo/.dia/worktrees/pane-1',
        branch: `dia/${PANE_ID}`,
        sourceRepo: '/repo'
      }

      yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        yield* gitOps.removeWorktree(info, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      // Should have logged a warning about the initial remove failing
      const logs = capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('Standard worktree remove failed')))
      assert.isTrue(logs.some((log) => log.includes('Pruned pane worktree')))
    })
  )

  it.effect('removeWorktree logs warning when both remove and prune fail', () =>
    Effect.gen(function* () {
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup(() => 1)
      const info: WorktreeInfo = {
        path: '/repo/.dia/worktrees/pane-1',
        branch: `dia/${PANE_ID}`,
        sourceRepo: '/repo'
      }

      yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        yield* gitOps.removeWorktree(info, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      // Should have logged warnings for both failures
      const logs = capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('Standard worktree remove failed')))
      assert.isTrue(logs.some((log) => log.includes('manual cleanup may be needed')))
    })
  )
})
