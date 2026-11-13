import { type GitOps, WorktreeCreateError, WorktreeReattachError } from '@dia/plugin'
import { makeGit } from '@dia-plugin/dia-git/git'
import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import {
  Context,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Result,
  Sink,
  Stream
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'
import { makeGitOps, slugify } from './git-ops'

class TestGitOps extends Context.Service<TestGitOps, GitOps>()('TestGitOps') {}

const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const WORKTREES_ROOT = '/worktrees'

const OWNER = { paneId: PANE_ID, label: 'Tab · repo' }

function makeFakeSpawner(
  exitCodeFor: (command: ChildProcess.Command) => number,
  registeredWorktrees: ReadonlyArray<string> | 'unavailable'
): ChildProcessSpawner.ChildProcessSpawner['Service'] {
  const unused = () => Effect.die('not used by makeGit')
  const text = (value: string) => Stream.encodeText(Stream.make(value))
  return ChildProcessSpawner.make((command) => {
    const isWorktreeList = argsOf(command)[0] === 'worktree' && argsOf(command)[1] === 'list'
    if (isWorktreeList && registeredWorktrees === 'unavailable') {
      return Effect.fail(
        PlatformError.systemError({
          _tag: 'NotFound',
          module: 'ChildProcess',
          method: 'spawn',
          description: 'git is not available'
        })
      )
    }
    const stdout =
      isWorktreeList && registeredWorktrees !== 'unavailable'
        ? registeredWorktrees.map((path) => `worktree ${path}\nHEAD abc\n`).join('\n')
        : ''
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.sync(() => ChildProcessSpawner.ExitCode(exitCodeFor(command))),
        isRunning: Effect.succeed(false),
        kill: unused,
        stdin: Sink.drain,
        stdout: text(stdout),
        stderr: text(''),
        all: text(stdout),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: unused()
      })
    )
  })
}

function argsOf(command: ChildProcess.Command): ReadonlyArray<string> {
  if (!ChildProcess.isStandardCommand(command)) throw new Error('expected a StandardCommand')
  return command.args
}

interface TestSetupOptions {
  readonly worktreeExists?: boolean
  readonly registeredWorktrees?: ReadonlyArray<string> | 'unavailable'
  readonly directoryEntries?: ReadonlyArray<string>
  readonly remove?: FileSystem.FileSystem['remove']
  readonly readDirectory?: FileSystem.FileSystem['readDirectory']
}

function makeTestSetup(
  exitCodeFor: (command: ChildProcess.Command) => number,
  {
    worktreeExists = false,
    registeredWorktrees = [],
    directoryEntries = [],
    remove = () => Effect.die('remove not expected'),
    readDirectory = () =>
      worktreeExists
        ? Effect.succeed([...directoryEntries])
        : Effect.fail(
            PlatformError.systemError({
              _tag: 'NotFound',
              module: 'FileSystem',
              method: 'readDirectory'
            })
          )
  }: TestSetupOptions = {}
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
    readDirectory,
    remove
  })

  const capturedLogs: unknown[] = []
  const captureLogger = Logger.make(({ message }) => {
    capturedLogs.push(...(Array.isArray(message) ? message : [message]))
  })

  const testLayer = Layer.provide(
    Layer.effect(
      TestGitOps,
      Effect.flatMap(makeGit, (git) => makeGitOps(WORKTREES_ROOT, git))
    ),
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
        return yield* gitOps.createWorktree('/repo', OWNER, Option.none())
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
        return yield* gitOps.createWorktree('/repo', OWNER, Option.none())
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
        return yield* gitOps.createWorktree('/repo', OWNER, Option.none())
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
        return yield* gitOps.createWorktree('/repo', OWNER, Option.none())
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer), Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, WorktreeCreateError)
      }
    })
  )

  it.effect('releaseWorktree succeeds on a zero exit', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(() => 0)
      const info: WorktreeInfo = {
        path: '/repo/.dia/worktrees/pane-1',
        branch: `dia/${PANE_ID}`,
        sourceRepo: '/repo'
      }

      yield* Effect.gen(function* () {
        const gitOps = yield* TestGitOps
        yield* gitOps.releaseWorktree(info, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))
    })
  )

  it.effect('releaseWorktree tries prune as fallback when remove fails', () =>
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
        yield* gitOps.releaseWorktree(info, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      const logs = capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('Standard worktree remove failed')))
      assert.isTrue(logs.some((log) => log.includes('Pruned worktree')))
    })
  )

  it.effect('releaseWorktree logs warning when both remove and prune fail', () =>
    Effect.gen(function* () {
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup(() => 1)
      const info: WorktreeInfo = {
        path: '/repo/.dia/worktrees/pane-1',
        branch: `dia/${PANE_ID}`,
        sourceRepo: '/repo'
      }

      yield* Effect.gen(function* () {
        const gitOps = yield* TestGitOps
        yield* gitOps.releaseWorktree(info, PANE_ID)
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      const logs = capturedLogs.map((log) => String(log))
      assert.isTrue(logs.some((log) => log.includes('Standard worktree remove failed')))
      assert.isTrue(logs.some((log) => log.includes('manual cleanup may be needed')))
    })
  )

  const busy = PlatformError.systemError({
    _tag: 'Busy',
    module: 'FileSystem',
    method: 'remove',
    description: 'EBUSY: resource busy or locked'
  })
  const isWorktreeRemove = (command: ChildProcess.Command): boolean =>
    argsOf(command)[0] === 'worktree' && argsOf(command)[1] === 'remove'

  const removeLeftover = (options: TestSetupOptions) => {
    const setup = makeTestSetup((command) => (isWorktreeRemove(command) ? 255 : 0), {
      worktreeExists: true,
      ...options
    })
    return Effect.gen(function* () {
      const gitOps = yield* TestGitOps
      const removing = yield* Effect.forkChild(gitOps.releaseWorktree(WORKTREE_INFO, PANE_ID))
      yield* TestClock.adjust(Duration.seconds(10))
      yield* Fiber.join(removing)
      return setup.capturedLogs.map(String)
    }).pipe(Effect.provide(setup.testLayer), Effect.provide(setup.loggerLayer))
  }

  it.effect(
    'releaseWorktree deletes the empty directory git leaves behind, retrying while it is busy',
    () =>
      Effect.gen(function* () {
        const removed: string[] = []
        let attempts = 0

        yield* removeLeftover({
          remove: (path) =>
            Effect.suspend(() => {
              attempts += 1
              if (attempts < 3) return Effect.fail(busy)
              removed.push(path)
              return Effect.void
            })
        })

        assert.deepStrictEqual(removed, [WORKTREE_INFO.path])
      })
  )

  it.effect('releaseWorktree keeps a leftover directory that still has files in it', () =>
    Effect.gen(function* () {
      const logs = yield* removeLeftover({ directoryEntries: ['notes.txt'] })

      assert.isTrue(logs.some((log) => log.includes('Left a worktree directory that is not empty')))
    })
  )

  it.effect('releaseWorktree stops retrying and keeps the directory once files appear in it', () =>
    Effect.gen(function* () {
      let reads = 0
      let removes = 0

      const logs = yield* removeLeftover({
        readDirectory: () => Effect.sync(() => (++reads === 1 ? [] : ['notes.txt'])),
        remove: () => Effect.sync(() => ++removes).pipe(Effect.andThen(Effect.fail(busy)))
      })

      assert.deepStrictEqual([removes, logs.some((log) => log.includes('not empty'))], [1, true])
    })
  )

  it.effect('releaseWorktree does nothing more when the directory is already gone', () =>
    Effect.gen(function* () {
      const logs = yield* removeLeftover({ worktreeExists: false })

      assert.isFalse(logs.some((log) => log.includes('worktree directory')))
    })
  )

  it.effect('releaseWorktree succeeds and warns when the empty directory stays busy', () =>
    Effect.gen(function* () {
      const logs = yield* removeLeftover({ remove: () => Effect.fail(busy) })

      assert.isTrue(
        logs.some((log) => log.includes('Could not remove the empty worktree directory'))
      )
    })
  )

  const reattach = (setup: ReturnType<typeof makeTestSetup>, info: WorktreeInfo = WORKTREE_INFO) =>
    Effect.gen(function* () {
      const gitOps = yield* TestGitOps
      return yield* gitOps.reattachWorktree(info, PANE_ID)
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

  it.effect('reattachWorktree fails with WorktreeReattachError when git worktree add fails', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        reattach(makeTestSetup((command) => (isWorktreeAdd(command) ? 128 : 0)))
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, WorktreeReattachError)
        assert.strictEqual(result.failure.cause, 'git worktree add exited with code 128')
      }
    })
  )

  it.effect('reattachWorktree reports a deleted branch and adds no worktree', () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      const setup = makeTestSetup((command) => {
        commands.push(command)
        return isRevParse(command) ? 1 : 0
      })

      const result = yield* Effect.result(reattach(setup))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.cause, `Branch ${WORKTREE_INFO.branch} no longer exists`)
      }
      assert.strictEqual(commands.filter(isWorktreeAdd).length, 0)
    })
  )

  it.effect('reattachWorktree reports any other rev-parse exit code as it is', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        reattach(makeTestSetup((command) => (isRevParse(command) ? 128 : 0)))
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.cause, 'git rev-parse exited with code 128')
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

      yield* reattach(setup, windowsInfo)

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
          { worktreeExists: true, registeredWorktrees: ['/repo'] }
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

  it.effect('reattachWorktree fails without adding when the worktree list cannot be read', () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = []
      const setup = makeTestSetup(
        (command) => {
          commands.push(command)
          return 0
        },
        { worktreeExists: true, registeredWorktrees: 'unavailable', directoryEntries: ['a.ts'] }
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

describe('slugify', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      'lowercases and replaces other characters with hyphens',
      'Fix Login: redirect_loop',
      'fix-login-redirect-loop'
    ],
    ['collapses runs of hyphens and symbols', 'a --- b !!! c', 'a-b-c'],
    ['trims leading and trailing hyphens', '--Hello--', 'hello'],
    ['returns empty when no letter or digit remains', '!!! ???', ''],
    ['drops non-ASCII letters', 'café au lait', 'caf-au-lait']
  ]
  for (const [name, input, expected] of cases) {
    it(name, () => assert.strictEqual(slugify(input), expected))
  }

  it('cuts at 40 characters without leaving a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(39)} bbbbbb`)
    assert.deepStrictEqual([slug.length, slug.endsWith('-')], [39, false])
  })

  it('keeps exactly 40 characters when the text is longer', () => {
    assert.strictEqual(slugify('a'.repeat(60)).length, 40)
  })
})

describe('createWorktree with a name hint', () => {
  const create = (hint: string, exitCodeFor: (command: ChildProcess.Command) => number) =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(exitCodeFor)
      return yield* Effect.gen(function* () {
        const gitOps = yield* TestGitOps
        return yield* gitOps.createWorktree('/repo', OWNER, Option.some(hint))
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))
    })

  it.effect('names the branch and directory after the slugified hint', () =>
    Effect.gen(function* () {
      const info = yield* create('Fix login redirect', (command) => (isRevParse(command) ? 1 : 0))

      assert.deepStrictEqual(
        [info.branch, info.path.endsWith('fix-login-redirect')],
        ['dia/fix-login-redirect', true]
      )
    })
  )

  it.effect('appends four hex digits when the branch already exists', () =>
    Effect.gen(function* () {
      let revParseCalls = 0
      const info = yield* create('Fix login', (command) => {
        if (!isRevParse(command)) return 0
        revParseCalls++
        return revParseCalls === 1 ? 0 : 1
      })

      assert.match(info.branch, /^dia\/fix-login-[0-9a-f]{4}$/)
    })
  )

  it.effect('falls back to an adjective-noun name when the hint has no letter or digit', () =>
    Effect.gen(function* () {
      const info = yield* create('!!!', (command) => (isRevParse(command) ? 1 : 0))

      assert.match(info.branch, /^dia\/[a-z]+-[a-z]+$/)
    })
  )
})
