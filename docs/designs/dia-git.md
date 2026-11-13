# `dia-git` plugin

Issue: draekien/dia#248, step 10 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0076 ("Git operations" row).

`dia-git` runs every git command dia needs and provides them as one service, `Git`, under `GitKey`. `dia-worktrees` keeps its ledger and its worktree rules (names, reattach, release, `.worktreeinclude`) on top of `Git`; `dia-meta` builds its repo and push on top of `Git`; the kernel's project file list (`ProjectEntries`) lists a repository's files through `Git` and walks the directory when no `Git` is provided. No other module under `src/` or `plugins/` starts a `git` process.

## Success criteria

1. `dia-worktrees` and `dia-meta` run no git process themselves. (Test: `plugins/dia-git/no-other-git.test.ts` reads every non-test `.ts` file under `src` and `plugins` and fails on a match of `ChildProcess\.make\(\s*['"`]git['"`]` outside `plugins/dia-git`. Test files keep their real-git fixtures.)
2. Worktree create, release and meta push behave as before. (Tests: the existing `git-ops.test.ts`, `git-ops-release.test.ts`, `worktree-include.test.ts`, `folder-move.test.ts`, `meta-repo.test.ts` and `meta-push.test.ts` pass against a `Git` from `makeGit`; their assertions on outcomes stay. `git-ops.test.ts`, whose fake spawner implements only `exitCode` and `string`, gets a fake whose `spawn` returns a handle. Hand test: create and release a worktree tab, and push the meta repo to a local bare remote, in the running app.)
3. The project file list works while `dia-git` reloads. (Test: `ProjectEntries.list` on a git repo with an ignored file returns the repo's files, without the ignored file, when `Git` is provided, and walks the directory, returning every file, when it is not. Hand test: disable `dia-git` on the Plugins page and open the `@` menu in a tab.)

## Decisions taken without the user

D1. **The contract (`Git`, `GitError`, `GitKey`) lives in the kernel, `src/host/services/git-seam.ts`, exported from `@dia/plugin`.** The kernel's `ProjectEntries` reads it, and `src/` cannot import a plugin module; `RunsKey` (`runs-seam.ts`) sets the precedent. Alternative: an exported module of `dia-git` (rejected: the root `CLAUDE.md` keeps such contracts for plugin-only use, and the kernel would need a second, duplicate key).

D2. **The kernel reads `Git` with `registry.use(GitKey, …)` per call and walks the directory when it gets `None`.** A `use` lease delays a reload of `dia-git` until `ls-files` ends, at most `SERVICE_USE_TIME_LIMIT` (30 s, `plugin-registry.ts`); after that the registry interrupts the call, `use` fails with `ServiceWithdrawnError`, and the kernel walks the directory. While `dia-git` is closing or not loaded `use` returns `None` and the walk answers. `ProjectEntriesLive` then requires `HostPlugins` (wired in `host-main.ts`), and its doc comment names `dia-git` instead of `git ls-files`. The walk does not apply `.gitignore`, so the `@` menu lists ignored files until `dia-git` is back. Alternative: `registry.inject` with no lease (rejected: a reload could close `dia-git` mid-call and the call would fail instead of walking). Alternative: keep `git ls-files` in the kernel (rejected: the issue moves it to `dia-git`).

D3. **`dia-worktrees` and `dia-meta` reach `Git` through `ctx.whenProvided([GitKey], …)`.** `dia-worktrees` provides `WorktreesKey` and serves `DiscardWorktree` inside that setup, so they are withdrawn while `dia-git` reloads and come back after it; a worktree tab opened in that gap fails as when `dia-worktrees` is not loaded. `WatchWorktrees` and `KeepWorktree` need no git and stay in the plugin's own setup. `dia-meta` keeps writing its files and providing `MetaRepoKey` in its own setup, because `forNewSession` needs no git and the meta repo's files must stay usable without git (`meta-repo.ts`); it holds the current `Git` in a `Ref<Option<Git>>` set inside `whenProvided` and cleared when that scope closes. Inside `whenProvided` it creates the repo's history when missing. While the ref is empty, `state`, `setRemote` and `push` return `MetaRepoFailed('Git is not available.')`. `makeGit` holds no state, so a call already running finishes after `dia-git` closes; `push` reads the ref once at its start, and `setRemote` and `push` hold the existing lock, so the next call sees the cleared ref. The kernel's `use` lease (D2) differs only in that it delays the reload instead. `dia-worktrees` opens its database and subscribes `onPathsMoved` in its own setup, outside `whenProvided`, so a moved folder's paths are rewritten before `HostReady` whatever the load order. Alternative: each plugin builds its own `Git` from the exported `makeGit` (D4) for everything (rejected: a second `Git` per plugin bypasses the service for the operations that run after setup, and the service is the one place a later step can add limits or logging for every caller).

D4. **Steps that run before `dia-git` may be loaded use `makeGit` from `dia-git`'s exported module `@dia-plugin/dia-git/git`, with Node services provided by the caller.** These are the `before` steps of the `1_dia_prefix` data migrations (stop `git fsmonitor--daemon`), which run before any plugin setup, and `dia-worktrees`' `onPathsMoved` repair (`git worktree repair`), which must finish in the plugin's own setup (the plugin-data-migrations design, row 126). The git process is still started by `dia-git`'s code. The import edge closes and reopens the whole of `dia-worktrees` and `dia-meta` (database, `onPathsMoved` subscription included) when `git.ts` gets a new module instance, that is when its code changes; a reload of `dia-git` with unchanged code reaches them only through D3. Alternative: `ctx.inject(GitKey)` in the repair (rejected: `dia-git` may load after `dia-worktrees`, and a failed repair is retried with `movePaths` already applied, so the repair would never run).

D5. **One operation per git capability a caller needs, named for what it does, not a `run(args)` pass-through.** Callers no longer assemble git command lines except `log`, whose format options belong to the caller (the meta push scan's `SCAN_LOG_OPTIONS`). Alternative: t3code's `VcsDriver.execute` plus typed helpers (rejected: `execute` lets every caller keep its own git knowledge, which is what this step removes).

D6. **Every operation runs git with `GIT_TERMINAL_PROMPT=0` added to the inherited environment, and interrupting an operation stops its git process.** (Unverified: whether killing `git` on Windows also stops its `git-remote-https` child; the old `meta-push` had the same behaviour.) dia has no terminal to answer a prompt; before this step only `dia-meta`'s push set it. A credential helper (Git Credential Manager) still opens its own window.

D7. **A git exit code other than the ones an operation documents fails with `GitError`** carrying `cwd`, `args`, `exitCode` (`-1` when git could not start) and `stderr`. Callers keep their existing fallbacks (`releaseWorktree` never fails, `ensureMetaRepo` logs and continues, the push reports `MetaRepoFailed` with the last stderr line). `GitError.args` and `stderr` pass through `redactUrlCredentials`, which moves from `meta-push.ts` to `git.ts` and is exported, so a token in a remote URL is never logged. Alternative: return `{ exitCode, stdout, stderr }` from each operation (rejected: every caller would re-check exit codes).

Documented exit codes: `resolveCommit`, `branchExists` and `currentBranch` read 1 as "none" (`--verify --quiet`, `symbolic-ref --quiet`); `remoteUrl` reads 2 as "none" (`remote get-url` of a missing remote); `ignoredMatching` runs `ls-files` and `check-ignore` as two spawns, the first's output as the second's stdin, so each exit code is checked, and reads 1 from `check-ignore` as "no match"; `listFiles` outside a repository exits 128 and fails; `stopFsmonitor` ignores every code. Any other non-zero code is a `GitError`. The old code read stdout without checking exit codes in `status`, `worktree list`, `ls-files` and the `ls-files | check-ignore` pipe, and treated any non-zero `rev-parse` as "no branch". Changed on purpose: `createWorktree`, `isRegisteredWorktree` (inside `reattachWorktree`) and `findIncludedFiles` now fail with their existing error types on such a code. `reattachWorktree` words a missing branch as `Branch <b> no longer exists` and any other failure as the `GitError`. `removeWorktree` without `force` fails on a tree with modified or untracked files; that `GitError` is `releaseWorktree`'s normal path to `WorktreeKept`, and `dia-git` does not log a `GitError` itself, its callers do. `meta-push` catches every `GitError`: `state` maps it to `MetaRepoFailed` with the last stderr line, and `setRemote` and `push` to `MetaRepoFailed` with the last stderr line or `exit code N`, as before. Kept: `releaseWorktree` counts 0 changed files when `status` fails; `ensureMetaRepo` treats a failed `resolveCommit` as no commit and continues to `init`; `ProjectEntries` walks on any `listFiles` failure.

D8. **`status` and `diff` are in the interface though no caller in this step uses `diff`.** The issue names them, and step 11 (#249, diffs and checkpoints per run) builds on them. `diff` takes revisions and paths and returns patch text; #249 adds what it needs (numstat, checkpoint refs) as new operations. `status` runs `git status --porcelain=v1 -z` with the default untracked mode; a rename is one entry, and `releaseWorktree`'s `changedFiles` is the entry count.

D9. **`meta-push` keeps `NETWORK_TIMEOUT`** and wraps `git.fetch` and `git.push` in `Effect.timeoutOption`; D6 makes the timeout stop git.

D10. **No `PLUGIN_API_VERSION` bump.** Adding a key to `@dia/plugin` does not change the plugin context; `RunEventsKey` (`dia-run-events`) was added without one. `plugins/dia-git/git.ts` is added to `tsconfig.plugin-exports.json` › `include`; it uses no `process` or `Buffer`.

## Interface

### Kernel seam (`src/host/services/git-seam.ts`, re-exported from `src/host/plugin-api.ts`)

```ts
/** A git command that could not start (`exitCode` -1) or exited with a code its operation does not accept. */
export class GitError extends Data.TaggedError('GitError')<{
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
}> {}

/** One changed path in `git status`: `code` is the two-letter porcelain XY code ('??' untracked). */
export interface GitStatusEntry { readonly code: string; readonly path: string }

/** Every git capability dia uses. Read it from {@link GitKey}; each operation fails with {@link GitError} unless its doc says otherwise. */
export interface Git {
  /** Initialises a repository in `cwd`. */
  readonly init: (cwd: string) => Effect.Effect<void, GitError>
  /** Stages every change in `cwd` and commits it as `author` with `message`, skipping hooks and signing. */
  readonly commitAll: (cwd: string, commit: { readonly message: string; readonly author: { readonly name: string; readonly email: string } }) => Effect.Effect<void, GitError>
  /** The full commit id `rev` names in `cwd`, or `None` when it names no commit. */
  readonly resolveCommit: (cwd: string, rev: string) => Effect.Effect<Option.Option<string>, GitError>
  /** Whether local branch `branch` exists in `repo`. */
  readonly branchExists: (repo: string, branch: string) => Effect.Effect<boolean, GitError>
  /** The branch checked out in `cwd`, or `None` when `HEAD` is detached. */
  readonly currentBranch: (cwd: string) => Effect.Effect<Option.Option<string>, GitError>
  /** Changed paths in `cwd`'s working tree, untracked included. */
  readonly status: (cwd: string) => Effect.Effect<ReadonlyArray<GitStatusEntry>, GitError>
  /** Patch text of `git diff <revisions> -- <paths>` in `cwd`; no revisions diffs the working tree against the index. */
  readonly diff: (cwd: string, options?: { readonly revisions?: ReadonlyArray<string>; readonly paths?: ReadonlyArray<string> }) => Effect.Effect<string, GitError>
  /** Output of `git log <options>` in `cwd`, with paths printed unquoted. */
  readonly log: (cwd: string, options: ReadonlyArray<string>) => Effect.Effect<string, GitError>
  /** Tracked and untracked files under `cwd` that `.gitignore` does not exclude, `/`-separated and relative. Fails with `GitError` when `cwd` is not in a repository. */
  readonly listFiles: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitError>
  /** Untracked, gitignored files in `repo` matching the patterns in file `patternsFile`, `/`-separated and relative. */
  readonly ignoredMatching: (repo: string, patternsFile: string) => Effect.Effect<ReadonlyArray<string>, GitError>
  /** The URL of remote `remote` in `cwd`, or `None` when it is not set. */
  readonly remoteUrl: (cwd: string, remote: string) => Effect.Effect<Option.Option<string>, GitError>
  /** Adds remote `remote` with `url`, or sets its URL when it exists. */
  readonly setRemoteUrl: (cwd: string, remote: string, url: string) => Effect.Effect<void, GitError>
  /** Fetches `remote`, pruning deleted branches. Interrupting it stops git. */
  readonly fetch: (cwd: string, remote: string) => Effect.Effect<void, GitError>
  /** Pushes `refspec` to `remote`. Interrupting it stops git. */
  readonly push: (cwd: string, remote: string, refspec: string) => Effect.Effect<void, GitError>
  /** Adds a worktree at `path` checking out `branch`; with `createBranch` the branch is created from `HEAD`. */
  readonly addWorktree: (repo: string, path: string, branch: string, options: { readonly createBranch: boolean }) => Effect.Effect<void, GitError>
  /** Removes the worktree at `path`; without `force` git refuses one with modified or untracked files. */
  readonly removeWorktree: (repo: string, path: string, options: { readonly force: boolean }) => Effect.Effect<void, GitError>
  /** Drops the registration of worktrees whose directory is gone. */
  readonly pruneWorktrees: (repo: string) => Effect.Effect<void, GitError>
  /** The paths of `repo`'s worktrees, the main one first, as git prints them. */
  readonly listWorktrees: (repo: string) => Effect.Effect<ReadonlyArray<string>, GitError>
  /** Tells git the worktrees of `repo` now live at `paths`. */
  readonly repairWorktrees: (repo: string, paths: ReadonlyArray<string>) => Effect.Effect<void, GitError>
  /** Stops the `git fsmonitor--daemon` watching `cwd`; succeeds when none runs. Never fails. */
  readonly stopFsmonitor: (cwd: string) => Effect.Effect<void>
}

/** The key `dia-git` provides {@link Git} under: `git`. A value counts when every member is a function. */
export const GitKey = ServiceKey.make('git', isGit)
```

### Exported module (`plugins/dia-git/git.ts`, `@dia-plugin/dia-git/git`)

```ts
/** Builds a {@link Git} that runs the `git` CLI through the platform spawner. Provide Node services. */
export const makeGit: Effect.Effect<Git, never, ChildProcessSpawner.ChildProcessSpawner>
```

### Host entry (`plugins/dia-git/host.ts`)

Builds `makeGit` with `NodeServices.layer` and provides it under `GitKey`. Manifest: `load: eager`, `exports: ["git.ts"]`.

### Kernel change (`src/host/services/project-entries.ts`)

`ProjectEntriesLive` requires `HostPlugins` instead of `ChildProcessSpawner`, and lists with `registry.use(GitKey, (git) => git.listFiles(cwd))`; `None`, an empty list, a `GitError` or a `ServiceWithdrawnError` walks the directory, as an `ls-files` failure did before.

## Key Data Structures

`GitError`, `GitStatusEntry` above. Paths in and out are OS paths for directories and `/`-separated repo-relative paths for files.

## Internal Decomposition

- **`git.ts` `run`** — spawns `git` with `GIT_TERMINAL_PROMPT=0` in a directory, optionally with a `Stream<Uint8Array>` as stdin, and collects exit code, stdout and stderr; it logs each run at debug level (`cwd`, redacted `args`, `exitCode`) and never at warning or error, because the caller decides whether a `GitError` matters; every operation calls it and maps exit codes.
- **`git.ts` operations** — one function per interface member; parsing (`-z` output, porcelain worktree list) stays next to the operation that reads it.

Callers after the change:

- `plugins/dia-worktrees/git-ops.ts` — `makeGitOps(worktreesRoot, git)`; keeps naming, reattach, release, leftover-directory removal and `.worktreeinclude` copying.
- `plugins/dia-worktrees/folder-move.ts` — `stopFsmonitors(treesRoot, git)` and `repairWorktrees(worktrees, git)`.
- `plugins/dia-meta/meta-repo.ts`, `meta-push.ts` — take `git: Git`.
- `plugins/dia-meta/data-migration.ts`, `plugins/dia-worktrees/data-migration.ts` — build `makeGit` with Node services.

## Rejected Alternatives

See D1, D2, D4, D5, D7. Also: **`dia-worktrees` absorbs `dia-git`** (rejected: `dia-meta` and the kernel would depend on the worktree ledger to run git).

## Refinement Record

**Round 1 — applied**
- *Correctness* — criterion 1's check covers non-test files only; test fixtures keep real git. `git-ops.test.ts`'s fake spawner gains `spawn`.
- *Correctness* — documented exit codes per operation and the behaviour changes they cause (D7).
- *Correctness* — D4's import edge reloads the whole importer, only when `git.ts` changes.
- *Correctness / behave as before* — `dia-meta` keeps `MetaRepoKey` and its files outside `whenProvided`; git-backed members degrade (D3).
- *Correctness* — D2's lease delay is bounded by 30 s, not "under a second"; `ProjectEntriesLive` wiring and doc named.
- *Project rules* — `git.ts` in `tsconfig.plugin-exports.json`; API version decision (D10).
- *Security* — `GitError` redacts URL credentials (D7).
- *Minor* — `status` format and `changedFiles` (D8); timeout and interruption (D6, D9).

**Round 1 — rejected**
- *YAGNI: drop `diff`* — rejected: the issue's scope names diff, and #249, the next step, builds on it.
- *Information Hiding: `log(options)` → `patchLog(commit, excludeRemote)`* — rejected: `patchLog` would be shaped around the one caller (Strategic Programming); the format options are the caller's output contract with its own parser (`push-scan.ts`).

**Round 2 — applied**
- *Correctness* — `state` returns `MetaRepoFailed` while git is absent instead of a false "no remote" (D3).
- *Correctness* — `meta-push` maps every `GitError` to `MetaRepoFailed` (D7).
- *Consistency* — what happens to an in-flight meta call when `dia-git` closes (D3); D3's rejection reason no longer contradicts D4.
- *Minor* — `listFiles` fails outside a repository; `ignoredMatching` checks both exit codes; `removeWorktree`'s expected failure; `ServiceWithdrawnError` walks; only `DiscardWorktree` and `WorktreesKey` wait for `GitKey`.

**Round 3 — applied**
- *Project rules (logging)* — `run` logs every git run at debug level.
- *Minor* — JSDoc on `Git`; criterion 1's pattern tolerates line breaks and quote styles; `run` takes a stdin stream for `ignoredMatching`; D6's Windows child-process claim marked unverified.

Rounds stopped after the budget of 3 (medium effort); round 3 left no blocker.
