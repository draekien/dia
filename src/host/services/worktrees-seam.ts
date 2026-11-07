import type { PaneId, WorktreeInfo } from '@shared/domain/pane'
import { ServiceKey } from '@shared/plugin/api'
import type { PluginRegistry, ServiceWithdrawnError } from '@shared/plugin/plugin-registry'
import { Data, Effect, type Option, Predicate } from 'effect'

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
 * The key the `worktrees` plugin provides its {@link GitOps} under. It reads as `GitOps` and accepts
 * a value with every `GitOps` operation as a function; any other value reads as not provided. Host
 * code reads it through {@link withGitOps}, one operation per call (ADR-0055).
 */
export const WorktreesKey = ServiceKey.make('worktrees', hasGitOperations)

/**
 * Runs `f` with the {@link GitOps} the loaded `worktrees` plugin provides under {@link WorktreesKey},
 * holding the plugin open until `f` ends. Returns `None` without running `f` when the plugin is not
 * loaded, is closing, or provides a value without every `GitOps` operation.
 * Fails with `f`'s error, or with `ServiceWithdrawnError` when the plugin closed while `f` ran. Keep
 * no `GitOps` after `f` returns; call it again for the next git operation.
 */
export const withGitOps = <A, E, R>(
  registry: Pick<PluginRegistry, 'use'>,
  f: (gitOps: GitOps) => Effect.Effect<A, E, R>
): Effect.Effect<Option.Option<A>, E | ServiceWithdrawnError, R> =>
  registry.use(WorktreesKey, f).pipe(Effect.withSpan('GitOps.with'))
