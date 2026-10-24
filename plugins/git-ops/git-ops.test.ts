import { type GitOps, WorktreeCreateError, WorktreeReattachError } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import { Context, Effect, FileSystem, Layer, Logger, Path, Result, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { makeGitOps } from './git-ops'

class TestGitOps extends Context.Service<TestGitOps, GitOps>()('TestGitOps') {}

const NL = String.fromCharCode(10)
const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function makeFakeSpawner(
  exitCodeFor: (command: ChildProcess.Command) => number,
  registeredWorktrees: ReadonlyArray<string>
): ChildProcessSpawner.ChildProcessSpawner['Service'] {
  const notImplemented = () => Effect.die('not implemented in fake spawner')
  const streamNotImplemented = () => Stream.die('not implemented in fake spawner')
  return ChildProcessSpawner.ChildProcessSpawner.of({
    spawn: notImplemented,
    exitCode: (command) => Effect.succeed(ChildProcessSpawner.ExitCode(exitCodeFor(command))),
    string: () =>
      Effect.succeed(
        registeredWorktrees.map((path) => `worktree ${path}${NL}HEAD abc${NL}`).join(NL)
      ),
    lines: notImplemented,
    streamString: streamNotImplemented,
    streamLines: streamNotImplemented
  })
}

function argsOf(command: ChildProcess.Command): ReadonlyArray<string> {
  if (!ChildProcess.isStandardCommand(command)) throw new Error('expected a StandardCommand')
  return command.args
}

interface TestSetupOptions {
  readonly worktreeExists?: boolean
  readonly registeredWorktrees?: ReadonlyArray<string>
  readonly directoryEntries?: ReadonlyArray<string>
}

function makeTestSetup(
  exitCodeFor: (command: ChildProcess.Command) => number,
  { worktreeExists = false, registeredWorktrees = [], directoryEntries = [] }: TestSetupOptions = {}
): {
  readonly capturedLogs: ReadonlyArray<unknown>
  readonly testLayer: Layer.Layer<TestGitOps>
  readonly loggerLayer: Layer.Layer<never>
} {
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    makeFakeSpawner(exitCodeFor, registeredWorktrees)
  )
  const fsLayer = FileSystem.layerNoop({
    exists: () => Effect.succeed(worktreeExists),
    readDirectory: () => Effect.succeed([...directoryEntries])
  })

  const capturedLogs: unknown[] = []
  const captureLogger = Logger.make(({ message }) => {
    capturedLogs.push(...(Array.isArray(message) ? message : [message]))
  })

  const testLayer = Layer.provide(
    Layer.effect(TestGitOps, makeGitOps),
    Layer.mergeAll(spawnerLayer, fsLayer, Path.layer)
  )
  const loggerLayer = Logger.layer([captureLogger], { mergeWithExisting: true })

  return { capturedLogs, testLayer, loggerLayer }
}

const WORKTREE_INFO: WorktreeInfo = {
  path: '/repo/.dia/worktrees/pane-1',
  branch: `dia/${PANE_ID}`,
  sourceRepo: '/repo'
}

const WORKTREES_ROOT = '/worktrees'
const isRevParse = (command: ChildProcess.Command): boolean => argsOf(command)[0] === 'rev-parse'
const isWorktreeAdd = (command: ChildProcess.Command): boolean =>
  argsOf(command)[0] === 'worktree' && argsOf(command)[1] === 'add'

describe('makeGitOps', () => {
  it.effect('createWorktree provisions a friendly dia/<slug> branch and matching directory', () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      // rev-parse exits non-zero => the generated branch is free; the add then succeeds.
      const { testLayer, loggerLayer } = makeTestSetup((command) => {
        commands.push(command)
        return isRevParse(command) ? 1 : 0
      })

      const info = yield* Effect.gen(function* () {
        const gitOps = yield* TestGitOps
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
      const commands: ChildProcess.Command[] = []
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
        const gitOps = yield* TestGitOps
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
      const commands: ChildProcess.Command[] = []
      const { testLayer, loggerLayer } = makeTestSetup(
        (command) => {
          commands.push(command)
          if (isRevParse(command)) {
            revParseCalls++
            return 1
          }
          return 0
        },
        { worktreeExists: true }
      )

      yield* Effect.gen(function* () {
        const gitOps = yield* TestGitOps
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
        const gitOps = yield* TestGitOps
        return yield* gitOps.createWorktree('/repo', PANE_ID, WORKTREES_ROOT)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer), Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, WorktreeCreateError)
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
        const gitOps = yield* TestGitOps
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
        const gitOps = yield* TestGitOps
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
        const gitOps = yield* TestGitOps
        yield* gitOps.removeWorktree(info, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      const logs = capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('Standard worktree remove failed')))
      assert.isTrue(logs.some((log) => log.includes('manual cleanup may be needed')))
    })
  )

  const reattach = (setup: ReturnType<typeof makeTestSetup>) =>
    Effect.gen(function* () {
      const gitOps = yield* TestGitOps
      return yield* gitOps.reattachWorktree(WORKTREE_INFO, PANE_ID)
    }).pipe(Effect.provide(setup.testLayer), Effect.provide(setup.loggerLayer))

  it.effect('reattachWorktree checks out the existing branch without -b or -B', () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      const setup = makeTestSetup((command) => {
        commands.push(command)
        return 0
      })

      const info = yield* reattach(setup)

      assert.deepStrictEqual(info, WORKTREE_INFO)
      const addCommands = commands.filter(isWorktreeAdd)
      assert.strictEqual(addCommands.length, 1)
      assert.deepStrictEqual(argsOf(addCommands[0]), [
        'worktree',
        'add',
        WORKTREE_INFO.path,
        WORKTREE_INFO.branch
      ])
    })
  )

  it.effect('reattachWorktree fails with WorktreeReattachError on a non-zero exit', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(reattach(makeTestSetup(() => 1)))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, WorktreeReattachError)
      }
    })
  )

  it.effect('reattachWorktree no-ops when the path is a registered worktree', () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      const setup = makeTestSetup(
        (command) => {
          commands.push(command)
          return 0
        },
        {
          worktreeExists: true,
          registeredWorktrees: ['/repo', WORKTREE_INFO.path],
          directoryEntries: ['file.ts']
        }
      )

      const info = yield* reattach(setup)

      assert.deepStrictEqual(info, WORKTREE_INFO)
      assert.strictEqual(commands.filter(isWorktreeAdd).length, 0)
      const logs = setup.capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('already a registered worktree')))
    })
  )

  it.effect('reattachWorktree matches a registered path written with backslashes', () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      const windowsInfo: WorktreeInfo = {
        ...WORKTREE_INFO,
        path: String.raw`C:\dia\worktrees\pane-1`
      }
      const setup = makeTestSetup(
        (command) => {
          commands.push(command)
          return 0
        },
        { worktreeExists: true, registeredWorktrees: ['c:/dia/worktrees/pane-1'] }
      )

      yield* Effect.gen(function* () {
        const gitOps = yield* TestGitOps
        return yield* gitOps.reattachWorktree(windowsInfo, PANE_ID)
      }).pipe(Effect.provide(setup.testLayer), Effect.provide(setup.loggerLayer))

      assert.strictEqual(commands.filter(isWorktreeAdd).length, 0)
    })
  )

  it.effect(
    'reattachWorktree re-adds the worktree into an existing empty unregistered directory',
    () =>
      Effect.gen(function* () {
        const commands: ChildProcess.Command[] = []
        const setup = makeTestSetup(
          (command) => {
            commands.push(command)
            return 0
          },
          { worktreeExists: true, registeredWorktrees: ['/repo'], directoryEntries: [] }
        )

        const info = yield* reattach(setup)

        assert.deepStrictEqual(info, WORKTREE_INFO)
        const addCommands = commands.filter(isWorktreeAdd)
        assert.strictEqual(addCommands.length, 1)
        assert.deepStrictEqual(argsOf(addCommands[0]).slice(0, 4), [
          'worktree',
          'add',
          WORKTREE_INFO.path,
          WORKTREE_INFO.branch
        ])
      })
  )

  it.effect('reattachWorktree refuses to reuse a non-empty unregistered directory', () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      const setup = makeTestSetup(
        (command) => {
          commands.push(command)
          return 0
        },
        {
          worktreeExists: true,
          registeredWorktrees: ['/repo'],
          directoryEntries: ['notes.txt']
        }
      )

      const result = yield* Effect.result(reattach(setup))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, WorktreeReattachError)
      }
      assert.strictEqual(commands.filter(isWorktreeAdd).length, 0)
    })
  )
})
