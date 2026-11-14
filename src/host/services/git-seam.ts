import { ServiceKey } from '@shared/plugin/api'
import { type Array as Arr, Data, type Effect, type Option, Predicate, Schema } from 'effect'

/**
 * A git command that could not start (`exitCode` -1) or exited with a code its {@link Git}
 * operation does not accept. `args` and `stderr` hold no URL credentials. `message` names the
 * command, the exit code and the last line git printed to stderr.
 */
export class GitError extends Data.TaggedError('GitError')<{
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
}> {
  override get message(): string {
    const lastLine = this.stderr.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
    return `git ${this.args.join(' ')} exited with code ${this.exitCode}${lastLine === '' ? '' : `: ${lastLine}`}`
  }
}

/** One changed path in `git status`: `code` is the two-letter porcelain XY code (`??` untracked). */
export interface GitStatusEntry {
  readonly code: string
  readonly path: string
}

/** A ref, the commit it points at and that commit's subject line, as {@link Git.refs} lists it. */
export interface GitRef {
  readonly name: string
  readonly commit: string
  readonly subject: string
}

/**
 * A file that differs between two commits, as {@link Git.changedFiles} reports it: `added` and
 * `deleted` are line counts, both 0 when `binary`.
 */
export const GitFileChange = Schema.Struct({
  path: Schema.String,
  added: Schema.Int,
  deleted: Schema.Int,
  binary: Schema.Boolean
})
/** A changed file; see {@link GitFileChange}. */
export type GitFileChange = typeof GitFileChange.Type

/** The author of a commit {@link Git.commitAll} or {@link Git.commitPaths} makes. */
export interface GitAuthor {
  readonly name: string
  readonly email: string
}

/**
 * Every git capability dia uses, as `dia-git` provides it under {@link GitKey}. Each operation
 * fails with {@link GitError} unless its doc says otherwise, and interrupting one stops its git
 * process. Directories are OS paths; file paths in and out are relative to the repository and
 * `/`-separated.
 */
export interface Git {
  /** Initialises a repository in `cwd`. */
  readonly init: (cwd: string) => Effect.Effect<void, GitError>
  /** Stages every change in `cwd` and commits it as `author` with `message`, skipping hooks and signing. */
  readonly commitAll: (
    cwd: string,
    commit: { readonly message: string; readonly author: GitAuthor }
  ) => Effect.Effect<void, GitError>
  /**
   * Stages `paths` in `cwd` and commits those paths only, as `author` with `message`, skipping
   * hooks and signing. Other staged and unstaged changes stay as they were. Every path must exist
   * in the working tree or the index.
   */
  readonly commitPaths: (
    cwd: string,
    paths: ReadonlyArray<string>,
    commit: { readonly message: string; readonly author: GitAuthor }
  ) => Effect.Effect<void, GitError>
  /** The full commit id `rev` names in `cwd`, or `None` when it names no commit. */
  readonly resolveCommit: (
    cwd: string,
    rev: string
  ) => Effect.Effect<Option.Option<string>, GitError>
  /** Whether local branch `branch` exists in `repo`. */
  readonly branchExists: (repo: string, branch: string) => Effect.Effect<boolean, GitError>
  /** The branch checked out in `cwd`, or `None` when `HEAD` is detached. */
  readonly currentBranch: (cwd: string) => Effect.Effect<Option.Option<string>, GitError>
  /** The changed paths in `cwd`'s working tree, untracked files included; a rename is one entry. */
  readonly status: (cwd: string) => Effect.Effect<ReadonlyArray<GitStatusEntry>, GitError>
  /**
   * The patch text of `git diff <revisions> -- <paths>` in `cwd`. No revisions diffs the working
   * tree against the index; no paths diffs every file.
   */
  readonly diff: (
    cwd: string,
    options?: {
      readonly revisions?: ReadonlyArray<string>
      readonly paths?: ReadonlyArray<string>
    }
  ) => Effect.Effect<string, GitError>
  /** The output of `git log <options>` in `cwd`, with paths printed unquoted. */
  readonly log: (cwd: string, options: ReadonlyArray<string>) => Effect.Effect<string, GitError>
  /**
   * The tracked files under `cwd` and the untracked ones `.gitignore` does not exclude. Fails when
   * `cwd` is not in a repository.
   */
  readonly listFiles: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitError>
  /** The untracked, gitignored files in `repo` that match the patterns in the file `patternsFile`. */
  readonly ignoredMatching: (
    repo: string,
    patternsFile: string
  ) => Effect.Effect<ReadonlyArray<string>, GitError>
  /** The URL of remote `remote` in `cwd`, or `None` when no such remote exists. */
  readonly remoteUrl: (
    cwd: string,
    remote: string
  ) => Effect.Effect<Option.Option<string>, GitError>
  /** Adds remote `remote` with `url`, or sets its URL when it exists. */
  readonly setRemoteUrl: (cwd: string, remote: string, url: string) => Effect.Effect<void, GitError>
  /** Fetches `remote`, pruning branches it deleted. */
  readonly fetch: (cwd: string, remote: string) => Effect.Effect<void, GitError>
  /** Pushes `refspec` to `remote`. */
  readonly push: (cwd: string, remote: string, refspec: string) => Effect.Effect<void, GitError>
  /**
   * Adds a worktree of `repo` at `path` checking out `branch`; with `createBranch` the branch is
   * created from `repo`'s `HEAD`.
   */
  readonly addWorktree: (
    repo: string,
    path: string,
    branch: string,
    options: { readonly createBranch: boolean }
  ) => Effect.Effect<void, GitError>
  /**
   * Removes the worktree at `path`. Without `force` it fails when the tree has modified or
   * untracked files.
   */
  readonly removeWorktree: (
    repo: string,
    path: string,
    options: { readonly force: boolean }
  ) => Effect.Effect<void, GitError>
  /** Drops the registration of `repo`'s worktrees whose directory is gone. */
  readonly pruneWorktrees: (repo: string) => Effect.Effect<void, GitError>
  /** The paths of `repo`'s worktrees, the main one first, as git prints them. */
  readonly listWorktrees: (repo: string) => Effect.Effect<ReadonlyArray<string>, GitError>
  /** Tells git that worktrees of `repo` now live at `paths`. */
  readonly repairWorktrees: (
    repo: string,
    paths: ReadonlyArray<string>
  ) => Effect.Effect<void, GitError>
  /** Stops the `git fsmonitor--daemon` watching `cwd`. Succeeds when none runs; never fails. */
  readonly stopFsmonitor: (cwd: string) => Effect.Effect<void>
  /**
   * Records `cwd`'s working tree (tracked files and the untracked files `.gitignore` does not
   * exclude) as a parentless commit with `message`, and points every ref in `refs` at it. Leaves
   * the index, `HEAD` and the working tree unchanged, and needs no git identity configured.
   */
  readonly snapshot: (
    cwd: string,
    refs: Arr.NonEmptyReadonlyArray<string>,
    message: string
  ) => Effect.Effect<void, GitError>
  /** The refs under the ref folder `prefix` (a name ending in `/`) in `cwd`'s repository, in name order. */
  readonly refs: (cwd: string, prefix: string) => Effect.Effect<ReadonlyArray<GitRef>, GitError>
  /** The files that differ between commits `from` and `to`; a rename is a deletion and an addition. */
  readonly changedFiles: (
    cwd: string,
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<GitFileChange>, GitError>
}

const GIT_MEMBERS = [
  'init',
  'commitAll',
  'commitPaths',
  'resolveCommit',
  'branchExists',
  'currentBranch',
  'status',
  'diff',
  'log',
  'listFiles',
  'ignoredMatching',
  'remoteUrl',
  'setRemoteUrl',
  'fetch',
  'push',
  'addWorktree',
  'removeWorktree',
  'pruneWorktrees',
  'listWorktrees',
  'repairWorktrees',
  'stopFsmonitor',
  'snapshot',
  'refs',
  'changedFiles'
] as const satisfies ReadonlyArray<keyof Git>

const isGit = (value: unknown): value is Git =>
  GIT_MEMBERS.every(
    (member) => Predicate.hasProperty(value, member) && Predicate.isFunction(value[member])
  )

/**
 * The key `dia-git` provides {@link Git} under, named `git`. A value counts as provided when every
 * member of {@link Git} is a function. Plugins read it with `ctx.whenProvided`; host code with
 * the registry's `use`.
 */
export const GitKey = ServiceKey.make('git', isGit)
