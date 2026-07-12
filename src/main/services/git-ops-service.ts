import { Command, CommandExecutor } from '@effect/platform'
import { Context, Data, Effect, Layer } from 'effect'
import type { WorktreeInfo } from '../domain/pane'
import type { PaneId } from '../domain/pane-tree'

export class WorktreeCreateError extends Data.TaggedError('WorktreeCreateError')<{
  readonly paneId: PaneId
  readonly sourceRepo: string
  readonly cause: unknown
}> {}

export class WorktreeRemoveError extends Data.TaggedError('WorktreeRemoveError')<{
  readonly paneId: PaneId
  readonly path: string
  readonly cause: unknown
}> {}

// Named for git operations generally, not just worktrees -- more git ops are
// expected to join this service in later bullets.
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
  }
>() {}

export const GitOpsServiceLive = Layer.effect(
  GitOpsService,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

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
        return yield* Effect.fail(
          new WorktreeCreateError({
            paneId,
            sourceRepo,
            cause: `git worktree add exited with code ${exitCode}`
          })
        )
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

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new WorktreeRemoveError({
            paneId,
            path: info.path,
            cause: `git worktree remove exited with code ${exitCode}`
          })
        )
      }

      yield* Effect.logInfo('Removed pane worktree', { paneId, path: info.path })
    })

    return { createWorktree, removeWorktree }
  })
)
