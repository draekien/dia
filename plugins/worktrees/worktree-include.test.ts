import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import type { PaneId } from '@shared/domain/pane'
import { Effect, FileSystem, Option, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { makeGitOps } from './git-ops'

const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001' as PaneId

const git = Effect.fnUntraced(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make('git', ['-c', 'user.name=dia', '-c', 'user.email=dia@example.com', ...args], {
      cwd
    })
  )
  assert.strictEqual(exitCode, 0, `git ${args.join(' ')}`)
})

const makeRepo = Effect.fn('makeRepo')(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-worktreeinclude-' })
  const write = Effect.fnUntraced(function* (relative: string, content: string) {
    const target = path.join(root, relative)
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFileString(target, content)
  })
  yield* git(root, 'init', '-q')
  yield* write('.gitignore', '.env*\nconfig/secrets.json\nnode_modules/\nvendor/\n')
  yield* write('package.json', '{}')
  yield* git(root, 'add', '.')
  yield* git(root, 'commit', '-q', '-m', 'init')
  for (const [relative, content] of Object.entries(files)) yield* write(relative, content)
  return root
})

const findIn = Effect.fn('findIn')(function* (files: Record<string, string>) {
  const root = yield* makeRepo(files)
  const gitOps = yield* makeGitOps('/unused')
  const found = yield* gitOps.findIncludedFiles(root, PANE_ID)
  return Option.map(found, (paths) => [...paths].sort())
})

describe('findIncludedFiles', () => {
  it.live('returns none when the project has no .worktreeinclude', () =>
    Effect.gen(function* () {
      const found = yield* findIn({ '.env': 'secret' })
      assert.isTrue(Option.isNone(found))
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.live('returns only the matched files that are untracked and gitignored', () =>
    Effect.gen(function* () {
      const found = yield* findIn({
        '.worktreeinclude': '.env\n.env.local\npackage.json\nnotes.txt\nconfig/secrets.json\n',
        '.env': 'a',
        '.env.local': 'b',
        '.env.production': 'not listed',
        'notes.txt': 'untracked but not ignored',
        'config/secrets.json': '{}'
      })
      assert.deepStrictEqual(Option.getOrThrow(found), [
        '.env',
        '.env.local',
        'config/secrets.json'
      ])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.live('leaves out a file a ! pattern negates', () =>
    Effect.gen(function* () {
      const found = yield* findIn({
        '.worktreeinclude': '.env*\n!.env.production\n',
        '.env': 'a',
        '.env.production': 'b'
      })
      assert.deepStrictEqual(Option.getOrThrow(found), ['.env'])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.live('matches a **/ pattern inside a wholly ignored directory', () =>
    Effect.gen(function* () {
      const found = yield* findIn({
        '.worktreeinclude': '**/config.json\n',
        'vendor/lib/config.json': '{}'
      })
      assert.deepStrictEqual(Option.getOrThrow(found), ['vendor/lib/config.json'])
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.live('does not read a .worktreeinclude below the project root', () =>
    Effect.gen(function* () {
      const found = yield* findIn({
        '.worktreeinclude': '.env\n',
        'vendor/.worktreeinclude': 'other.txt\n',
        'vendor/other.txt': 'x',
        '.env': 'a'
      })
      assert.deepStrictEqual(Option.getOrThrow(found), ['.env'])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe('copyIncludedFiles', () => {
  it.live(
    'copies each file into the worktree, keeps an existing file and reports one it cannot read',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const sourceRepo = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-source-' })
        const worktree = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-worktree-' })
        yield* fs.makeDirectory(path.join(sourceRepo, 'config'))
        yield* fs.writeFileString(path.join(sourceRepo, 'config', 'secrets.json'), 'source')
        yield* fs.writeFileString(path.join(sourceRepo, '.env'), 'source')
        yield* fs.writeFileString(path.join(worktree, '.env'), 'already here')
        const gitOps = yield* makeGitOps('/unused')

        const failures = yield* gitOps.copyIncludedFiles(
          { path: worktree, branch: 'dia/calm-fox', sourceRepo },
          ['config/secrets.json', '.env', 'missing.txt'],
          PANE_ID
        )

        assert.strictEqual(
          yield* fs.readFileString(path.join(worktree, 'config', 'secrets.json')),
          'source'
        )
        assert.strictEqual(yield* fs.readFileString(path.join(worktree, '.env')), 'already here')
        assert.deepStrictEqual(
          failures.map((failure) => failure.path),
          ['missing.txt']
        )
        assert.match(failures[0]?.reason ?? '', /^ENOENT/)
      }).pipe(Effect.provide(NodeServices.layer))
  )
})
