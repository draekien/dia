import { Command, CommandExecutor, FileSystem, Path } from '@effect/platform'
import type { WorktreeInfo } from '@shared/domain/pane'
import type { PaneId } from '@shared/domain/pane-tree'
import { Context, Data, Effect, Layer, Random } from 'effect'
import { generateWorktreeSlug } from './worktree-slug'

/**
 * Failure raised when `GitOpsService.createWorktree` cannot create a git
 * worktree for a pane. Carries the pane id, source repo path, and the
 * underlying cause so callers can log or surface the failure.
 */
export class WorktreeCreateError extends Data.TaggedError('WorktreeCreateError')<{
  readonly paneId: PaneId
  readonly sourceRepo: string
  readonly cause: unknown
}> {}

/**
 * Failure raised when `GitOpsService.removeWorktree` cannot remove or prune
 * a pane's git worktree. Carries the pane id, worktree path, and the
 * underlying cause so callers can log or surface the failure.
 */
export class WorktreeRemoveError extends Data.TaggedError('WorktreeRemoveError')<{
  readonly paneId: PaneId
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Failure raised when `GitOpsService.reattachWorktree` cannot re-add a pane's
 * previously-created worktree on resume. Carries the pane id, worktree path, and
 * the underlying cause so callers can log or surface the failure.
 */
export class WorktreeReattachError extends Data.TaggedError('WorktreeReattachError')<{
  readonly paneId: PaneId
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Service for git operations backing pane lifecycles. Named for git
 * operations generally, not just worktrees -- more git ops are expected to
 * join this service in later bullets.
 *
 * `createWorktree` provisions a new worktree and branch for a pane from a
 * source repo, giving both a friendly `dia/<adjective-noun>` name (see
 * {@link generateWorktreeSlug}) under `worktreesRoot` rather than an opaque
 * UUID, and collision-checking the generated name against existing branches
 * and directories before use; `removeWorktree` tears one down, falling back to
 * `git worktree prune` if standard removal fails; `reattachWorktree` re-adds a
 * pane's existing worktree/branch on resume (worktrees are removed on graceful
 * shutdown but their branch persists). Obtain an implementation via
 * `GitOpsServiceLive` and provide it at the composition root.
 */
export class GitOpsService extends Context.Tag('GitOpsService')<
  GitOpsService,
  {
    /**
     * Provisions a fresh worktree for a pane: generates a friendly, unique
     * `dia/<adjective-noun>` branch and a matching directory under
     * `worktreesRoot`, then `git worktree add <dir> -b <branch>`. The generated
     * name is collision-checked against both existing branches in `sourceRepo`
     * and existing directories under `worktreesRoot`, regenerating on a clash.
     */
    readonly createWorktree: (
      sourceRepo: string,
      paneId: PaneId,
      worktreesRoot: string
    ) => Effect.Effect<WorktreeInfo, WorktreeCreateError>
    readonly removeWorktree: (
      info: WorktreeInfo,
      paneId: PaneId
    ) => Effect.Effect<void, WorktreeRemoveError>
    /**
     * Re-adds the worktree described by `info` at its original path, checking out
     * its existing `dia/<paneId>` branch (via `git worktree add <path> <branch>`,
     * never `-b`/`-B`, so committed work is preserved, not reset). No-ops if the
     * worktree path is already present on disk (an already-live pane, or a
     * crash-orphaned worktree whose recovery is out of scope). Returns the same
     * `info` so callers can thread it back into the pane config.
     */
    readonly reattachWorktree: (
      info: WorktreeInfo,
      paneId: PaneId
    ) => Effect.Effect<WorktreeInfo, WorktreeReattachError>
  }
>() {}

/**
 * Live `GitOpsService` layer backed by the platform `CommandExecutor`,
 * shelling out to the `git` CLI. Provide this at the composition root
 * wherever `GitOpsService` is required.
 */
export const GitOpsServiceLive = Layer.effect(
  GitOpsService,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const branchExists = Effect.fn('GitOpsService.branchExists')(function* (
      sourceRepo: string,
      paneId: PaneId,
      branch: string
    ) {
      const command = Command.make(
        'git',
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`
      ).pipe(Command.workingDirectory(sourceRepo))
      const exitCode = yield* executor
        .exitCode(command)
        .pipe(Effect.mapError((cause) => new WorktreeCreateError({ paneId, sourceRepo, cause })))
      return exitCode === 0
    })

    // A worktree's directory is removed on graceful shutdown but its branch persists (and
    // lingers after a pane is closed), so a fresh pane can generate a name whose branch already
    // exists even though no directory does -- both must be checked. After a bounded number of
    // clashes (astronomically unlikely) fall back to appending random hex to force a unique name.
    const MAX_SLUG_ATTEMPTS = 50
    const findAvailableWorktreeName = Effect.fn('GitOpsService.findAvailableWorktreeName')(
      function* (sourceRepo: string, paneId: PaneId, worktreesRoot: string) {
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
      }
    )

    const createWorktree = Effect.fn('GitOpsService.createWorktree')(function* (
      sourceRepo: string,
      paneId: PaneId,
      worktreesRoot: string
    ) {
      const { path: worktreePath, branch } = yield* findAvailableWorktreeName(
        sourceRepo,
        paneId,
        worktreesRoot
      )
      const command = Command.make('git', 'worktree', 'add', worktreePath, '-b', branch).pipe(
        Command.workingDirectory(sourceRepo)
      )
      const exitCode = yield* executor
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

    const removeWorktree = Effect.fn('GitOpsService.removeWorktree')(function* (
      info: WorktreeInfo,
      paneId: PaneId
    ) {
      const command = Command.make('git', 'worktree', 'remove', '--force', info.path).pipe(
        Command.workingDirectory(info.sourceRepo)
      )
      const exitCode = yield* executor
        .exitCode(command)
        .pipe(
          Effect.mapError((cause) => new WorktreeRemoveError({ paneId, path: info.path, cause }))
        )

      if (exitCode === 0) {
        yield* Effect.logInfo('Removed pane worktree', { paneId, path: info.path })
        return
      }

      yield* Effect.logWarning('Standard worktree remove failed, trying with --prune', {
        paneId,
        path: info.path,
        exitCode
      })
      const pruneCommand = Command.make('git', 'worktree', 'prune').pipe(
        Command.workingDirectory(info.sourceRepo)
      )
      const pruneExitCode = yield* executor
        .exitCode(pruneCommand)
        .pipe(
          Effect.mapError((cause) => new WorktreeRemoveError({ paneId, path: info.path, cause }))
        )

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

    const reattachWorktree = Effect.fn('GitOpsService.reattachWorktree')(function* (
      info: WorktreeInfo,
      paneId: PaneId
    ) {
      const alreadyPresent = yield* fs.exists(info.path).pipe(Effect.orElseSucceed(() => false))
      if (alreadyPresent) {
        yield* Effect.logWarning(
          'Worktree path already present; skipping reattach (crash-orphan recovery is out of scope)',
          { paneId, path: info.path }
        )
        return info
      }

      const command = Command.make('git', 'worktree', 'add', info.path, info.branch).pipe(
        Command.workingDirectory(info.sourceRepo)
      )
      const exitCode = yield* executor
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

    return { createWorktree, removeWorktree, reattachWorktree }
  })
)
