import { type Command, CommandExecutor, FileSystem } from '@effect/platform'
import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import { Effect, Either, Layer, Logger } from 'effect'
import {
  GitOpsService,
  GitOpsServiceLive,
  WorktreeCreateError,
  WorktreeReattachError
} from './git-ops-service'

const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function makeFakeExecutor(
  exitCodeFor: (command: Command.Command) => number
): CommandExecutor.CommandExecutor {
  const notImplemented = () => Effect.die('not implemented in fake executor')
  return {
    [CommandExecutor.TypeId]: CommandExecutor.TypeId,
    exitCode: (command: Command.Command) =>
      Effect.succeed(CommandExecutor.ExitCode(exitCodeFor(command))),
    start: notImplemented,
    string: notImplemented,
    lines: notImplemented,
    stream: notImplemented,
    streamLines: notImplemented
  }
}

function argsOf(command: Command.Command): ReadonlyArray<string> {
  if (command._tag !== 'StandardCommand') throw new Error('expected a StandardCommand')
  return command.args
}

function makeTestSetup(
  exitCodeFor: (command: Command.Command) => number,
  worktreeExists = false
): {
  readonly capturedLogs: ReadonlyArray<unknown>
  readonly testLayer: Layer.Layer<GitOpsService>
  readonly loggerLayer: Layer.Layer<never>
} {
  const executorLayer = Layer.succeed(
    CommandExecutor.CommandExecutor,
    makeFakeExecutor(exitCodeFor)
  )
  const fsLayer = Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({ exists: () => Effect.succeed(worktreeExists) })
  )

  const capturedLogs: unknown[] = []
  const captureLogger = Logger.make(({ message }) => {
    capturedLogs.push(...(Array.isArray(message) ? message : [message]))
  })

  const testLayer = Layer.provide(GitOpsServiceLive, Layer.merge(executorLayer, fsLayer))
  const loggerLayer = Logger.add(captureLogger)

  return { capturedLogs, testLayer, loggerLayer }
}

const WORKTREE_INFO: WorktreeInfo = {
  path: '/repo/.dia/worktrees/pane-1',
  branch: `dia/${PANE_ID}`,
  sourceRepo: '/repo'
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
      let commandCount = 0
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup(() => {
        commandCount++
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

      const logs = capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('Standard worktree remove failed')))
      assert.isTrue(logs.some((log) => log.includes('manual cleanup may be needed')))
    })
  )

  it.effect('reattachWorktree checks out the existing branch without -b or -B', () =>
    Effect.gen(function* () {
      const commands: Command.Command[] = []
      const { testLayer, loggerLayer } = makeTestSetup((command) => {
        commands.push(command)
        return 0
      })

      const info = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.reattachWorktree(WORKTREE_INFO, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(info, WORKTREE_INFO)
      assert.strictEqual(commands.length, 1)
      assert.deepStrictEqual(argsOf(commands[0]), [
        'worktree',
        'add',
        WORKTREE_INFO.path,
        WORKTREE_INFO.branch
      ])
    })
  )

  it.effect('reattachWorktree fails with WorktreeReattachError on a non-zero exit', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(() => 1)

      const result = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.reattachWorktree(WORKTREE_INFO, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer), Effect.either)

      assert.isTrue(Either.isLeft(result))
      if (Either.isLeft(result)) {
        assert.instanceOf(result.left, WorktreeReattachError)
      }
    })
  )

  it.effect('reattachWorktree no-ops when the worktree path already exists', () =>
    Effect.gen(function* () {
      const commands: Command.Command[] = []
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup((command) => {
        commands.push(command)
        return 0
      }, true)

      const info = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.reattachWorktree(WORKTREE_INFO, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(info, WORKTREE_INFO)
      assert.strictEqual(commands.length, 0)
      const logs = capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('already present')))
    })
  )
})
