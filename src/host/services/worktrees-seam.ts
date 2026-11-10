import type { PaneId, ReleaseOutcome, WorktreeInfo, WorktreeOwner } from '@shared/domain/pane'
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
 * The git operations behind every worktree dia creates, recorded in the `worktrees` plugin's
 * ledger and listed on Settings › Worktrees (ADR-0073).
 *
 * `createWorktree` provisions a worktree from `sourceRepo` for `owner` in a directory the plugin
 * chooses, on branch `dia/<name>`, and returns where it put them. `<name>` is `nameHint` reduced
 * to lowercase letters, digits and hyphens, or a generated adjective-noun name when `nameHint` is
 * `None`; a `-<hex>` suffix is added when a directory or branch with that name exists.
 * `reattachWorktree` re-adds the worktree described by `info` on resume, checking out its existing
 * branch so committed work is preserved; it returns `info` and does nothing when the path is
 * already a registered worktree, reuses a path that exists but is an empty, unregistered
 * directory, and fails with `WorktreeReattachError` when that directory is not empty or when the
 * branch no longer exists (cause `Branch <branch> no longer exists`). `releaseWorktree` frees a
 * worktree the caller no longer runs in: a tree with no modified or untracked files is removed and
 * its branch kept (`WorktreeReleased`), and a tree with any is left on disk for the user to decide
 * (`WorktreeKept`); it never fails, because teardown must not block on it.
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
    owner: WorktreeOwner,
    nameHint: Option.Option<string>
  ) => Effect.Effect<WorktreeInfo, WorktreeCreateError>
  readonly releaseWorktree: (info: WorktreeInfo, paneId: PaneId) => Effect.Effect<ReleaseOutcome>
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
  'releaseWorktree',
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
