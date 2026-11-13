import type { WorktreeInfo } from '@dia/plugin'
import { Effect, FileSystem, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

/**
 * Stops the `git fsmonitor--daemon` of each worktree directly under `treesRoot`, so the folder
 * can be renamed on Windows (a running daemon holds its worktree open). A directory without a
 * daemon, and a missing `treesRoot`, are skipped. Never fails.
 */
export const stopFsmonitors = Effect.fn('Worktrees.stopFsmonitors')(function* (treesRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const names = yield* fs.readDirectory(treesRoot).pipe(Effect.orElseSucceed(() => []))
  for (const name of names) {
    const directory = path.join(treesRoot, name)
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make('git', ['fsmonitor--daemon', 'stop']).pipe(ChildProcess.setCwd(directory))
      )
      .pipe(Effect.orElseSucceed(() => -1))
    yield* Effect.logDebug('Asked git to stop the fsmonitor daemon', { directory, exitCode })
  }
})

/**
 * Runs `git worktree repair` with the new paths of `worktrees` that exist on disk, once per
 * source repository, so git finds each worktree at its new path. A failure is logged per
 * repository and does not fail the effect.
 */
export const repairWorktrees = Effect.fn('Worktrees.repairWorktrees')(function* (
  worktrees: ReadonlyArray<WorktreeInfo>
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const byRepo = new Map<string, Array<string>>()
  for (const worktree of worktrees) {
    if (!(yield* fs.exists(worktree.path).pipe(Effect.orElseSucceed(() => false)))) continue
    byRepo.set(worktree.sourceRepo, [...(byRepo.get(worktree.sourceRepo) ?? []), worktree.path])
  }
  for (const [sourceRepo, paths] of byRepo) {
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make('git', ['worktree', 'repair', ...paths]).pipe(
          ChildProcess.setCwd(sourceRepo)
        )
      )
      .pipe(Effect.orElseSucceed(() => -1))
    if (exitCode === 0) yield* Effect.logInfo('Repaired moved worktrees', { sourceRepo, paths })
    else
      yield* Effect.logWarning('Could not repair moved worktrees', { sourceRepo, paths, exitCode })
  }
})
