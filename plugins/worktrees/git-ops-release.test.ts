import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Option, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { makeGitOps } from './git-ops'

const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = { paneId: PANE_ID, label: 'Tab · repo' }

const git = Effect.fnUntraced(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* spawner.string(
    ChildProcess.make('git', ['-c', 'user.name=dia', '-c', 'user.email=dia@example.com', ...args], {
      cwd
    })
  )
})

const setup = Effect.fn('setup')(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-release-repo-' })
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-release-trees-' })
  yield* git(repo, 'init', '-q')
  yield* fs.writeFileString(path.join(repo, '.gitignore'), 'node_modules/\n')
  yield* fs.writeFileString(path.join(repo, 'a.txt'), 'one')
  yield* git(repo, 'add', '.')
  yield* git(repo, 'commit', '-q', '-m', 'init')
  const gitOps = yield* makeGitOps(root)
  const info = yield* gitOps.createWorktree(repo, OWNER, Option.some('Fix login'))
  return { fs, path, repo, gitOps, info }
})

const branches = (repo: string) => git(repo, 'branch', '--list', 'dia/*')

describe('releaseWorktree against a real repository', () => {
  it.live('removes a clean worktree, deletes its directory and keeps its branch', () =>
    Effect.gen(function* () {
      const { fs, repo, gitOps, info } = yield* setup()

      const outcome = yield* gitOps.releaseWorktree(info, PANE_ID)

      assert.deepStrictEqual(
        [outcome, yield* fs.exists(info.path), (yield* branches(repo)).includes('dia/fix-login')],
        [{ _tag: 'WorktreeReleased' }, false, true]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('keeps a worktree with a modified tracked file and counts it', () =>
    Effect.gen(function* () {
      const { fs, path, gitOps, info } = yield* setup()
      yield* fs.writeFileString(path.join(info.path, 'a.txt'), 'changed')

      const outcome = yield* gitOps.releaseWorktree(info, PANE_ID)

      assert.deepStrictEqual(
        [outcome, yield* fs.exists(path.join(info.path, 'a.txt'))],
        [{ _tag: 'WorktreeKept', changedFiles: 1 }, true]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('keeps a worktree with untracked files and counts each one', () =>
    Effect.gen(function* () {
      const { fs, path, gitOps, info } = yield* setup()
      yield* fs.writeFileString(path.join(info.path, 'b.txt'), 'new')
      yield* fs.writeFileString(path.join(info.path, 'c.txt'), 'new')

      const outcome = yield* gitOps.releaseWorktree(info, PANE_ID)

      assert.deepStrictEqual(outcome, { _tag: 'WorktreeKept', changedFiles: 2 })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('removes a worktree whose only extra files are ignored', () =>
    Effect.gen(function* () {
      const { fs, path, gitOps, info } = yield* setup()
      yield* fs.makeDirectory(path.join(info.path, 'node_modules'))
      yield* fs.writeFileString(path.join(info.path, 'node_modules', 'dep.js'), 'x')

      const outcome = yield* gitOps.releaseWorktree(info, PANE_ID)

      assert.deepStrictEqual(
        [outcome, yield* fs.exists(info.path)],
        [{ _tag: 'WorktreeReleased' }, false]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live(
    'releases a worktree whose directory was already deleted and prunes its registration',
    () =>
      Effect.gen(function* () {
        const { fs, repo, gitOps, info } = yield* setup()
        yield* fs.remove(info.path, { recursive: true })

        const outcome = yield* gitOps.releaseWorktree(info, PANE_ID)

        assert.deepStrictEqual(
          [outcome, (yield* git(repo, 'worktree', 'list', '--porcelain')).includes('fix-login')],
          [{ _tag: 'WorktreeReleased' }, false]
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('releases an empty unregistered leftover directory and deletes it', () =>
    Effect.gen(function* () {
      const { fs, repo, gitOps, info } = yield* setup()
      yield* git(repo, 'worktree', 'remove', info.path)
      yield* fs.makeDirectory(info.path)

      const outcome = yield* gitOps.releaseWorktree(info, PANE_ID)

      assert.deepStrictEqual(
        [outcome, yield* fs.exists(info.path)],
        [{ _tag: 'WorktreeReleased' }, false]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe('forceRemoveWorktree against a real repository', () => {
  it.live('deletes a dirty worktree directory and keeps its branch', () =>
    Effect.gen(function* () {
      const { fs, path, repo, gitOps, info } = yield* setup()
      yield* fs.writeFileString(path.join(info.path, 'b.txt'), 'new')

      yield* gitOps.forceRemoveWorktree(info, PANE_ID)

      assert.deepStrictEqual(
        [yield* fs.exists(info.path), (yield* branches(repo)).includes('dia/fix-login')],
        [false, true]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('does not fail when the directory is already gone', () =>
    Effect.gen(function* () {
      const { fs, gitOps, info } = yield* setup()
      yield* fs.remove(info.path, { recursive: true })

      yield* gitOps.forceRemoveWorktree(info, PANE_ID)

      assert.isFalse(yield* fs.exists(info.path))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
