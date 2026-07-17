import { Command, CommandExecutor, FileSystem } from '@effect/platform'
import type { WorktreeInfo } from '@shared/domain/pane'
import type { PaneId } from '@shared/domain/pane-tree'
import { Context, Data, Effect, Layer } from 'effect'

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
 * source repo; `removeWorktree` tears one down, falling back to `git
 * worktree prune` if standard removal fails; `reattachWorktree` re-adds a
 * pane's existing worktree/branch on resume (worktrees are removed on graceful
 * shutdown but their branch persists). Obtain an implementation via
 * `GitOpsServiceLive` and provide it at the composition root.
 */
export class GitOpsService extends Context.Tag('GitOpsService')<
  GitOpsService,
  {
    readonly createWorktree: (
      sourceRepo: string,
      paneId: PaneId,
      worktreePath: string
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

    const createWorktree = Effect.fn('GitOpsService.createWorktree')(function* (
      sourceRepo: string,
      paneId: PaneId,
      worktreePath: string
    ) {
      const branch = `dia/${paneId}`
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
