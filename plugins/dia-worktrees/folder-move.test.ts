import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { repairWorktrees, stopFsmonitors } from './folder-move'

const git = Effect.fnUntraced(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* spawner.string(
    ChildProcess.make('git', ['-c', 'user.name=dia', '-c', 'user.email=dia@example.com', ...args], {
      cwd
    })
  )
})

const comparable = (value: string) => value.replaceAll('\\', '/').toLowerCase()

describe('moving the worktrees folder', () => {
  it.live('lets git find each worktree at its new path after the folder is renamed', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-move-repo-' })
      const userData = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: 'dia-move-data-' })
      )
      yield* git(repo, 'init', '-q')
      yield* git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
      const oldTrees = path.join(userData, 'plugins', 'worktrees', 'trees')
      yield* fs.makeDirectory(oldTrees, { recursive: true })
      yield* git(repo, 'worktree', 'add', '-q', path.join(oldTrees, 'heron'), '-b', 'dia/heron')
      yield* stopFsmonitors(oldTrees, yield* makeGit)
      yield* fs.rename(
        path.join(userData, 'plugins', 'worktrees'),
        path.join(userData, 'plugins', 'dia-worktrees')
      )
      const moved = path.join(userData, 'plugins', 'dia-worktrees', 'trees', 'heron')

      yield* repairWorktrees(
        [{ path: moved, branch: 'dia/heron', sourceRepo: repo }],
        yield* makeGit
      )

      const listed = yield* git(repo, 'worktree', 'list', '--porcelain')
      assert.include(comparable(listed), `worktree ${comparable(moved)}`)
      assert.notInclude(listed, 'prunable')
      yield* stopFsmonitors(
        path.join(userData, 'plugins', 'dia-worktrees', 'trees'),
        yield* makeGit
      )
      yield* git(repo, 'fsmonitor--daemon', 'stop').pipe(Effect.ignore)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
