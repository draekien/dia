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

/** Service key under which the `worktrees` plugin provides a {@link GitOpsFactory}. */
export const WORKTREES_KEY = 'worktrees'

/**
 * The git operations behind a pane's worktree lifecycle.
 *
 * `createWorktree` provisions a worktree and a `dia/<adjective-noun>` branch for a pane from
 * `sourceRepo` under `worktreesRoot`, using a name that clashes with no existing branch or
 * directory, and returns where it put them. `reattachWorktree` re-adds the worktree described by
 * `info` on resume, checking out its existing branch so committed work is preserved; it returns
 * `info` and does nothing when the path is already a registered worktree, reuses a path that
 * exists but is an empty, unregistered directory, and fails with `WorktreeReattachError` when
 * that directory is not empty. `removeWorktree` tears one down and does
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

/** Creates the {@link GitOps} a pane uses; the value a plugin provides under {@link WORKTREES_KEY}. */
export type GitOpsFactory = () => GitOps

class GitOpsPluginError extends Data.TaggedError('GitOpsPluginError')<{
  readonly cause: unknown
}> {}

const hasGitOperations = (value: unknown): value is GitOps =>
  Predicate.hasProperty(value, 'createWorktree') &&
  Predicate.isFunction(value.createWorktree) &&
  Predicate.hasProperty(value, 'removeWorktree') &&
  Predicate.isFunction(value.removeWorktree) &&
  Predicate.hasProperty(value, 'reattachWorktree') &&
  Predicate.isFunction(value.reattachWorktree)

/**
 * Resolves the {@link GitOps} for one pane from the factory the `worktrees` plugin provides under
 * {@link WORKTREES_KEY}. It never fails. Returns `None`, after logging why, when the plugin is not
 * loaded, provides a non-function, or its factory throws or returns something without the three
 * operations; the caller then opens a new pane without a worktree and refuses to resume a pane
 * that has one. Call it once per pane open; a plugin reload applies from the next call.
 */
export const resolveGitOps = Effect.fn('GitOps.resolve')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(WORKTREES_KEY)
  if (Option.isNone(provided)) {
    yield* Effect.logWarning('The worktrees plugin is not loaded')
    return Option.none<GitOps>()
  }
  const factory = provided.value
  if (!Predicate.isFunction(factory)) {
    yield* Effect.logWarning('The worktrees service is not a function', {
      received: typeof factory
    })
    return Option.none<GitOps>()
  }
  return yield* Effect.try({
    try: () => factory(),
    catch: (cause) => new GitOpsPluginError({ cause })
  }).pipe(
    Effect.flatMap((created) =>
      hasGitOperations(created)
        ? Effect.succeed(Option.some(created))
        : Effect.logError(
            'The worktrees factory did not return createWorktree, removeWorktree and reattachWorktree'
          ).pipe(Effect.as(Option.none<GitOps>()))
    ),
    Effect.catch((error) =>
      Effect.logError('The worktrees plugin failed to create its service', {
        cause: error.cause
      }).pipe(Effect.as(Option.none<GitOps>()))
    )
  )
})
