import { type Command, CommandExecutor, FileSystem, Path } from '@effect/platform'
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

  const testLayer = Layer.provide(
    GitOpsServiceLive,
    Layer.mergeAll(executorLayer, fsLayer, Path.layer)
  )
  const loggerLayer = Logger.add(captureLogger)

  return { capturedLogs, testLayer, loggerLayer }
}

const WORKTREE_INFO: WorktreeInfo = {
  path: '/repo/.dia/worktrees/pane-1',
  branch: `dia/${PANE_ID}`,
  sourceRepo: '/repo'
}

const WORKTREES_ROOT = '/worktrees'
const isRevParse = (command: Command.Command): boolean => argsOf(command)[0] === 'rev-parse'
const isWorktreeAdd = (command: Command.Command): boolean =>
  argsOf(command)[0] === 'worktree' && argsOf(command)[1] === 'add'

describe('GitOpsService', () => {
  it.effect('createWorktree provisions a friendly dia/<slug> branch and matching directory', () =>
    Effect.gen(function* () {
      const commands: Command.Command[] = []
      // rev-parse exits non-zero => the generated branch is free; the add then succeeds.
      const { testLayer, loggerLayer } = makeTestSetup((command) => {
        commands.push(command)
        return isRevParse(command) ? 1 : 0
      })

      const info = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.createWorktree('/repo', PANE_ID, WORKTREES_ROOT)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      const addCommands = commands.filter(isWorktreeAdd)
      assert.strictEqual(addCommands.length, 1)
      const addArgs = argsOf(addCommands[0])
      assert.deepStrictEqual(addArgs.slice(0, 3), ['worktree', 'add', info.path])
      // -b makes this the create incantation (not a reattach); the slug is not the pane UUID.
      assert.strictEqual(addArgs[3], '-b')
      assert.strictEqual(addArgs[4], info.branch)
      assert.match(info.branch, /^dia\/[a-z]+-[a-z]+$/)
      assert.notStrictEqual(info.branch, `dia/${PANE_ID}`)
      assert.strictEqual(info.sourceRepo, '/repo')
      const slug = info.branch.slice('dia/'.length)
      assert.isTrue(info.path.endsWith(slug))
      assert.isTrue(info.path.includes('worktrees'))
    })
  )

  it.effect('createWorktree regenerates the slug when the branch is already taken', () =>
    Effect.gen(function* () {
      let revParseCalls = 0
      const commands: Command.Command[] = []
      // First candidate's branch already exists (rev-parse exits 0); the next is free.
      const { testLayer, loggerLayer } = makeTestSetup((command) => {
        commands.push(command)
        if (isRevParse(command)) {
          revParseCalls++
          return revParseCalls === 1 ? 0 : 1
        }
        return 0
      })

      const info = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.createWorktree('/repo', PANE_ID, WORKTREES_ROOT)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.strictEqual(revParseCalls, 2)
      const addCommands = commands.filter(isWorktreeAdd)
      assert.strictEqual(addCommands.length, 1)
      // The single add uses the second (free) candidate, matching the returned info.
      assert.strictEqual(argsOf(addCommands[0])[4], info.branch)
    })
  )

  it.effect('createWorktree skips a slug whose directory already exists on disk', () =>
    Effect.gen(function* () {
      // Every branch is free (rev-parse exits 1), yet fs.exists reports every directory present,
      // so each candidate is still rejected on the directory clash before its branch is checked.
      let revParseCalls = 0
      const commands: Command.Command[] = []
      const { testLayer, loggerLayer } = makeTestSetup((command) => {
        commands.push(command)
        if (isRevParse(command)) {
          revParseCalls++
          return 1
        }
        return 0
      }, true)

      yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.createWorktree('/repo', PANE_ID, WORKTREES_ROOT)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      // A directory clash is caught before the branch check, so rev-parse is never reached.
      assert.strictEqual(revParseCalls, 0)
      // No slug survived the loop, so the only add is the hex-suffixed fallback (exactly one).
      assert.strictEqual(commands.filter(isWorktreeAdd).length, 1)
    })
  )

  it.effect('createWorktree fails with WorktreeCreateError on non-zero exit', () =>
    Effect.gen(function* () {
      // rev-parse non-zero (branch free) so a slug is accepted; the add then fails.
      const { testLayer, loggerLayer } = makeTestSetup((command) => (isRevParse(command) ? 1 : 1))

      const result = yield* Effect.gen(function* () {
        const gitOps = yield* GitOpsService
        return yield* gitOps.createWorktree('/repo', PANE_ID, WORKTREES_ROOT)
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
