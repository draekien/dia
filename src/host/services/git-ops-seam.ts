import type { WorktreeInfo } from '@shared/domain/pane'
import type { PaneId } from '@shared/domain/pane-tree'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Data, Effect, Option, Predicate } from 'effect'

/**
 * Failure raised when `GitOps.createWorktree` cannot create a git worktree for a pane. Carries
 * the pane id, source repo path, and the underlying cause so callers can log or surface the
 * failure.
 */
export class WorktreeCreateError extends Data.TaggedError('WorktreeCreateError')<{
  readonly paneId: PaneId
  readonly sourceRepo: string
  readonly cause: unknown
}> {}

/**
 * Failure raised when `GitOps.removeWorktree` cannot remove or prune a pane's git worktree.
 * Carries the pane id, worktree path, and the underlying cause so callers can log or surface the
 * failure.
 */
export class WorktreeRemoveError extends Data.TaggedError('WorktreeRemoveError')<{
  readonly paneId: PaneId
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Failure raised when `GitOps.reattachWorktree` cannot re-add a pane's previously-created
 * worktree on resume. Carries the pane id, worktree path, and the underlying cause so callers
 * can log or surface the failure.
 */
export class WorktreeReattachError extends Data.TaggedError('WorktreeReattachError')<{
  readonly paneId: PaneId
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Service key under which the `git-ops` plugin provides a {@link GitOpsFactory}.
 */
export const GIT_OPS_KEY = 'gitOps'

/**
 * The git operations behind a pane's worktree lifecycle.
 *
 * `createWorktree` provisions a worktree and a `dia/<adjective-noun>` branch for a pane from
 * `sourceRepo` under `worktreesRoot`, using a name that clashes with no existing branch or
 * directory, and returns where it put them. `reattachWorktree` re-adds the worktree described by
 * `info` on resume, checking out its existing branch so committed work is preserved; it returns
 * `info` and does nothing when the path already exists. `removeWorktree` tears one down and does
 * not fail when git cannot prune it, because pane teardown must not block on that.
 */
export interface GitOps {
  readonly createWorktree: (
    sourceRepo: string,
    paneId: PaneId,
    worktreesRoot: string
  ) => Effect.Effect<WorktreeInfo, WorktreeCreateError>
  readonly removeWorktree: (
    info: WorktreeInfo,
    paneId: PaneId
  ) => Effect.Effect<void, WorktreeRemoveError>
  readonly reattachWorktree: (
    info: WorktreeInfo,
    paneId: PaneId
  ) => Effect.Effect<WorktreeInfo, WorktreeReattachError>
}

/** Creates the {@link GitOps} a pane uses; the value a plugin provides under {@link GIT_OPS_KEY}. */
export type GitOpsFactory = () => GitOps

const unavailableReason = 'The git-ops plugin is not loaded'

const unavailableGitOps: GitOps = {
  createWorktree: (sourceRepo, paneId) =>
    Effect.fail(new WorktreeCreateError({ paneId, sourceRepo, cause: unavailableReason })),
  reattachWorktree: (info, paneId) =>
    Effect.fail(new WorktreeReattachError({ paneId, path: info.path, cause: unavailableReason })),
  removeWorktree: (info, paneId) =>
    Effect.logWarning('Left a pane worktree on disk because the git-ops plugin is not loaded', {
      paneId,
      path: info.path
    })
}

class GitOpsPluginError extends Data.TaggedError('GitOpsPluginError')<{
  readonly cause: unknown
}> {}

/**
 * Resolves the {@link GitOps} for one pane from the factory the `git-ops` plugin provides under
 * {@link GIT_OPS_KEY}. It never fails. When the plugin is not loaded, provides a non-function, or
 * its factory throws, the problem is logged and the result refuses to create or reattach a
 * worktree (so no pane runs un-isolated) and leaves an existing worktree on disk at removal.
 * Call it once per pane open; a plugin reload applies from the next call.
 */
export const resolveGitOps = Effect.fn('GitOps.resolve')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(GIT_OPS_KEY)
  if (Option.isNone(provided)) {
    yield* Effect.logWarning('The git-ops plugin is not loaded; worktree operations are refused')
    return unavailableGitOps
  }
  if (!Predicate.isFunction(provided.value)) {
    yield* Effect.logWarning(
      'The gitOps service is not a function; worktree operations are refused',
      {
        received: typeof provided.value
      }
    )
    return unavailableGitOps
  }
  const factory = provided.value as GitOpsFactory
  return yield* Effect.try({
    try: () => {
      const created = factory() as Partial<GitOps> | null | undefined
      if (
        created === null ||
        created === undefined ||
        !Predicate.isFunction(created.createWorktree) ||
        !Predicate.isFunction(created.removeWorktree) ||
        !Predicate.isFunction(created.reattachWorktree)
      ) {
        throw new TypeError(
          'The gitOps factory did not return createWorktree, removeWorktree and reattachWorktree'
        )
      }
      return created as GitOps
    },
    catch: (cause) => new GitOpsPluginError({ cause })
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(
        'The git-ops plugin failed to create its service; worktree operations are refused',
        {
          cause: error.cause
        }
      ).pipe(Effect.as(unavailableGitOps))
    )
  )
})
