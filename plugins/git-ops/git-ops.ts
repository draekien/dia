import {
  type GitOps,
  WorktreeCreateError,
  WorktreeReattachError,
  WorktreeRemoveError
} from '@dia/plugin'
import type { WorktreeInfo } from '@shared/domain/pane'
import type { PaneId } from '@shared/domain/pane-tree'
import { Effect, FileSystem, Path, Random } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { generateWorktreeSlug } from './worktree-slug'

const PORCELAIN_WORKTREE_PREFIX = 'worktree '

/**
 * Builds the {@link GitOps} the `git-ops` plugin provides, shelling out to the `git` CLI through
 * the platform `ChildProcessSpawner`. Run it once in the plugin's setup with the Node platform
 * services provided.
 */
export const makeGitOps = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const branchExists = Effect.fn('GitOps.branchExists')(function* (
    sourceRepo: string,
    paneId: PaneId,
    branch: string
  ) {
    const command = ChildProcess.make('git', [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`
    ]).pipe(ChildProcess.setCwd(sourceRepo))
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(Effect.mapError((cause) => new WorktreeCreateError({ paneId, sourceRepo, cause })))
    return exitCode === 0
  })

  // A worktree's directory is removed on graceful shutdown but its branch persists (and
  // lingers after a pane is closed), so a fresh pane can generate a name whose branch already
  // exists even though no directory does -- both must be checked. After a bounded number of
  // clashes (astronomically unlikely) fall back to appending random hex to force a unique name.
  const MAX_SLUG_ATTEMPTS = 50
  const findAvailableWorktreeName = Effect.fn('GitOps.findAvailableWorktreeName')(function* (
    sourceRepo: string,
    paneId: PaneId,
    worktreesRoot: string
  ) {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = yield* generateWorktreeSlug()
      const branch = `dia/${slug}`
      const dirPath = path.join(worktreesRoot, slug)
      const dirTaken = yield* fs.exists(dirPath).pipe(Effect.orElseSucceed(() => false))
      const taken = dirTaken || (yield* branchExists(sourceRepo, paneId, branch))
      if (!taken) return { path: dirPath, branch }
    }

    const base = yield* generateWorktreeSlug()
    const suffix = (yield* Random.nextIntBetween(0x1000, 0x10000)).toString(16)
    const slug = `${base}-${suffix}`
    return { path: path.join(worktreesRoot, slug), branch: `dia/${slug}` }
  })

  const createWorktree = Effect.fn('GitOps.createWorktree')(function* (
    sourceRepo: string,
    paneId: PaneId,
    worktreesRoot: string
  ) {
    const { path: worktreePath, branch } = yield* findAvailableWorktreeName(
      sourceRepo,
      paneId,
      worktreesRoot
    )
    const command = ChildProcess.make('git', ['worktree', 'add', worktreePath, '-b', branch]).pipe(
      ChildProcess.setCwd(sourceRepo)
    )
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(Effect.mapError((cause) => new WorktreeCreateError({ paneId, sourceRepo, cause })))

    if (exitCode !== 0) {
      return yield* new WorktreeCreateError({
        paneId,
        sourceRepo,
        cause: `git worktree add exited with code ${exitCode}`
      })
    }

    yield* Effect.logInfo('Created pane worktree', { paneId, path: worktreePath, branch })
    return { path: worktreePath, branch, sourceRepo }
  })

  const removeWorktree = Effect.fn('GitOps.removeWorktree')(function* (
    info: WorktreeInfo,
    paneId: PaneId
  ) {
    const command = ChildProcess.make('git', ['worktree', 'remove', '--force', info.path]).pipe(
      ChildProcess.setCwd(info.sourceRepo)
    )
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(Effect.mapError((cause) => new WorktreeRemoveError({ paneId, path: info.path, cause })))

    if (exitCode === 0) {
      yield* Effect.logInfo('Removed pane worktree', { paneId, path: info.path })
      return
    }

    yield* Effect.logWarning('Standard worktree remove failed, trying with --prune', {
      paneId,
      path: info.path,
      exitCode
    })
    const pruneCommand = ChildProcess.make('git', ['worktree', 'prune']).pipe(
      ChildProcess.setCwd(info.sourceRepo)
    )
    const pruneExitCode = yield* spawner
      .exitCode(pruneCommand)
      .pipe(Effect.mapError((cause) => new WorktreeRemoveError({ paneId, path: info.path, cause })))

    if (pruneExitCode !== 0) {
      // Log the error but don't fail — the worktree directory can be cleaned up later.
      // This ensures pane teardown doesn't block on git worktree removal failures.
      yield* Effect.logWarning('Failed to prune worktree; manual cleanup may be needed', {
        paneId,
        path: info.path,
        pruneExitCode
      })
      return
    }

    yield* Effect.logInfo('Pruned pane worktree', { paneId, path: info.path })
  })

  const comparablePath = (value: string): string => {
    const forward = value.replaceAll('\\', '/').replace(/\/+$/, '')
    return /^[a-zA-Z]:/.test(forward) ? forward.toLowerCase() : forward
  }

  const isRegisteredWorktree = Effect.fn('GitOps.isRegisteredWorktree')(function* (
    info: WorktreeInfo,
    paneId: PaneId
  ) {
    const output = yield* spawner
      .string(
        ChildProcess.make('git', ['worktree', 'list', '--porcelain']).pipe(
          ChildProcess.setCwd(info.sourceRepo)
        )
      )
      .pipe(
        Effect.mapError((cause) => new WorktreeReattachError({ paneId, path: info.path, cause }))
      )
    const target = comparablePath(info.path)
    return output
      .split(/\r?\n/)
      .some(
        (line) =>
          line.startsWith(PORCELAIN_WORKTREE_PREFIX) &&
          comparablePath(line.slice(PORCELAIN_WORKTREE_PREFIX.length)) === target
      )
  })

  const reattachWorktree = Effect.fn('GitOps.reattachWorktree')(function* (
    info: WorktreeInfo,
    paneId: PaneId
  ) {
    const pathExists = yield* fs.exists(info.path).pipe(Effect.orElseSucceed(() => false))
    if (pathExists) {
      if (yield* isRegisteredWorktree(info, paneId)) {
        yield* Effect.logWarning(
          'Worktree path is already a registered worktree; skipping reattach',
          {
            paneId,
            path: info.path
          }
        )
        return info
      }

      const entries = yield* fs
        .readDirectory(info.path)
        .pipe(
          Effect.mapError((cause) => new WorktreeReattachError({ paneId, path: info.path, cause }))
        )
      if (entries.length > 0) {
        return yield* new WorktreeReattachError({
          paneId,
          path: info.path,
          cause: 'path exists, is not a registered worktree, and is not empty'
        })
      }
      yield* Effect.logWarning('Reusing an empty unregistered worktree directory', {
        paneId,
        path: info.path
      })
    }

    const command = ChildProcess.make('git', ['worktree', 'add', info.path, info.branch]).pipe(
      ChildProcess.setCwd(info.sourceRepo)
    )
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(
        Effect.mapError((cause) => new WorktreeReattachError({ paneId, path: info.path, cause }))
      )

    if (exitCode !== 0) {
      return yield* new WorktreeReattachError({
        paneId,
        path: info.path,
        cause: `git worktree add exited with code ${exitCode}`
      })
    }

    yield* Effect.logInfo('Reattached pane worktree', {
      paneId,
      path: info.path,
      branch: info.branch
    })
    return info
  })

  const gitOps: GitOps = { createWorktree, removeWorktree, reattachWorktree }
  return gitOps
})
