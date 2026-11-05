import type { PaneId, WorktreeInfo } from '@shared/domain/pane'
import { WORKTREES_KEY } from '@shared/plugin/api'
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
 * Failure raised when a pane's previously-created worktree cannot be re-attached on resume:
 * `GitOps.reattachWorktree` failed, or the worktrees plugin is not loaded. Carries the pane id,
 * worktree path, and a `cause` that is a failure object or a message string.
 */
export class WorktreeReattachError extends Data.TaggedError('WorktreeReattachError')<{
  readonly paneId: PaneId
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Failure raised when `GitOps.findIncludedFiles` cannot run git to match a project's
 * `.worktreeinclude`. Carries the pane id, source repo path, and the underlying cause.
 */
export class WorktreeIncludeError extends Data.TaggedError('WorktreeIncludeError')<{
  readonly paneId: PaneId
  readonly sourceRepo: string
  readonly cause: unknown
}> {}

/**
 * A file `GitOps.copyIncludedFiles` could not copy: its repo-relative `path` and a one-line
 * `reason` to show the user.
 */
export interface IncludedFileFailure {
  readonly path: string
  readonly reason: string
}

/**
 * The git operations behind a pane's worktree lifecycle.
 *
 * `createWorktree` provisions a worktree and a `dia/<adjective-noun>` branch for a pane from
 * `sourceRepo` under `worktreesRoot`, using a name that clashes with no existing branch or
 * directory, and returns where it put them. `reattachWorktree` re-adds the worktree described by
 * `info` on resume, checking out its existing branch so committed work is preserved; it returns
 * `info` and does nothing when the path is already a registered worktree, reuses a path that
 * exists but is an empty, unregistered directory, and fails with `WorktreeReattachError` when
 * that directory is not empty or when the branch no longer exists (cause
 * `Branch <branch> no longer exists`). `removeWorktree` tears one down, deletes the directory when git
 * leaves it on disk empty, and does not fail when git cannot prune it or the directory cannot be
 * deleted, because pane teardown must not block on that.
 *
 * `findIncludedFiles` returns `None` when `sourceRepo` has no `.worktreeinclude`, otherwise the
 * repo-relative paths (forward slashes) of the untracked files that match it and are gitignored;
 * it fails with `WorktreeIncludeError` when git cannot run. `copyIncludedFiles` copies those
 * paths from `worktree.sourceRepo` into `worktree.path`, never overwriting a file that already
 * exists there; it never fails and returns one {@link IncludedFileFailure} per file it could not
 * copy.
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
  readonly findIncludedFiles: (
    sourceRepo: string,
    paneId: PaneId
  ) => Effect.Effect<Option.Option<ReadonlyArray<string>>, WorktreeIncludeError>
  readonly copyIncludedFiles: (
    worktree: WorktreeInfo,
    files: ReadonlyArray<string>,
    paneId: PaneId
  ) => Effect.Effect<ReadonlyArray<IncludedFileFailure>>
}

const gitOperations = [
  'createWorktree',
  'removeWorktree',
  'reattachWorktree',
  'findIncludedFiles',
  'copyIncludedFiles'
] as const

const hasGitOperations = (value: unknown): value is GitOps =>
  gitOperations.every(
    (operation) => Predicate.hasProperty(value, operation) && Predicate.isFunction(value[operation])
  )

/**
 * Resolves the {@link GitOps} the `worktrees` plugin provides under `WORKTREES_KEY`. It never
 * fails. Returns `None`, after logging why, when the plugin is not loaded or what it provides
 * lacks one of its operations; the caller then opens a new pane without a worktree and refuses to
 * resume a pane that has one. Call it once per pane open; a plugin reload applies from the next
 * call.
 */
export const resolveGitOps = Effect.fn('GitOps.resolve')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(WORKTREES_KEY)
  if (Option.isNone(provided)) {
    yield* Effect.logDebug('The worktrees plugin is not loaded')
    return Option.none<GitOps>()
  }
  if (!hasGitOperations(provided.value)) {
    yield* Effect.logError('The worktrees service does not have every GitOps operation', {
      required: gitOperations
    })
    return Option.none<GitOps>()
  }
  return Option.some(provided.value)
})
