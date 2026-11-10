# Worktree ledger and issue worktrees

Status: accepted. ADR: ADR-0073 (amends ADR-0062's `worktrees` seam and ADR-0072).

## Name and Purpose

The `worktrees` plugin owns the lifecycle of every git worktree dia creates — for user-opened panes and for hired agents' issues — records each in a ledger shown on Settings › Worktrees, and never deletes modified or untracked files without the user's decision (ignored files, such as `node_modules`, are deleted with a clean worktree); the `org` plugin runs each issue of a project the user opted in inside the issue's own worktree.

## Scope

In scope:

- `plugins/worktrees`: a SQLite ledger (`ctx.database`), a `renderer` entry with a Settings page (pattern: `plugins/mcp/renderer.ts`, `plugins/mcp/plugin.json`), the release rule, name hints for branches.
- `src/host/services/worktrees-seam.ts`: the `GitOps` contract below. `pane-supervisor.ts`, `pane-workspace.ts`, `tab-setup.ts` adapt.
- Removing `worktreesRoot` from `HostInit` and its uses: `src/shared/ipc/host-process.ts:21`, `src/main/index.ts:210`, `src/host/host-main.ts:165`, `makePaneWorkspaceLive` (`pane-workspace.ts:228`), `WorktreeRequest.Create.worktreesRoot` (`pane-supervisor.ts:104,841`), and the tests at `pane-supervisor.test.ts` (513, 548, 569, 1308) and `pane-workspace.test.ts:757`. New worktrees go under `<userData>/plugins/worktrees/trees`; existing worktrees keep their stored paths under `<userData>/worktrees`.
- `WorktreeOwner` lives in `src/shared/domain/pane.ts` beside `WorktreeInfo` (platform-neutral); `src/host/plugin-api.ts` exports `WorktreeInfo`, `WorktreeOwner`, `ReleaseOutcome`, `WorktreeReleased`, `WorktreeKept` as values (`plugins/org/calls.ts:1` imports schema values from `@dia/plugin` the same way); `PLUGIN_API_VERSION` 0.0.35 → 0.0.36 and every shipped `plugin.json` `api` (ADR-0032 precedent: ADR-0048, ADR-0056).
- `plugins/org`: a per-project "Run issues in worktrees" switch on the org settings page, `project_worktrees` and `issue_worktrees` tables, `issue-workspace.ts`, dispatcher changes.
- Pane and tab removal treat a kept worktree as handled (criterion 8): `PaneWorkspace.removeWorktree` calls `releaseWorktree`; `WorktreeKept` returns `Option.none` (success) and logs the path; `WorktreeReleased` keeps the `stillThere` check; the `WORKTREES_PLUGIN_NOT_LOADED` failure is unchanged. The `openPane` finalizer logs the `ReleaseOutcome`. Releasing twice (finalizer, then `retireTab`) is safe because a non-`Active` row returns its recorded outcome. At quit, `supervisor.closeAll()` runs before the host scope (and so the plugins) closes (`src/host/host-main.ts:283`).
- `WorktreeRequest.Create` carries `label` in place of `worktreesRoot`; `PaneWorkspace` passes `Tab · <request.name ?? project.displayName>` and `nameHint` `None`, so pane branches keep today's adjective-noun names. `tab-setup.ts` does not change.
- ADR-0073 and its index row.

Out of scope: merged-branch tracking and PR delivery; the Executive assistant session (keeps the project directory); when panes tear down worktrees (still at pane close and at quit); moving existing worktrees; Remove Project with `force` (leaves worktrees untouched, as today); worktrees created before the ledger and never reattached are not listed; `PROTOCOL_VERSION` (plugin calls use the one `CallPlugin` RPC; `DiaRpcs` does not change).

## Success criteria

1. With the project switch on, a started issue's session `cwd` is `<userData>/plugins/worktrees/trees/<slug>` on branch `dia/<slug>`, where `<slug>` is the slugified `<title> <id first 8>`; the ledger row is `Active` with label `Issue · <title>`; the project's `.worktreeinclude` files are copied in.
2. With the switch off, or a project whose `isGitRepo` is false, the `cwd` is the project directory and no worktree is created.
3. Two issues of one switched-on project running at the same time have different `cwd`s.
4. A started issue resumed after an app restart runs in the same path, byte-identical (`docs/reasoning/2026-07-17-worktree-reattach-resume-incantation.md`).
5. Switch on and no plugin provides `WorktreesKey`: the issue stays `todo`, and a warning is logged once per issue until it can start. When the plugin is provided later, the issue starts with no other trigger.
6. Only issues the scheduler picks get a worktree: with cap 3 and 20 `todo` issues, at most 3 worktrees exist after the first pass.
7. When an issue is in neither the org's startable nor started set (Finish, `objective_stop`, triage, reassignment away from the org) its worktree is released: clean → directory removed, branch kept, ledger `Removed`; modified or untracked files → directory kept, ledger `NeedsDecision{changedFiles}`.
8. Closing a pane or quitting dia with modified or untracked files in a pane worktree leaves the directory and sets the row `NeedsDecision`. Archiving or deleting a tab, and Remove Project without `force`, treat that as success: the tab or project is removed and the worktree is listed on Settings › Worktrees. Archive keeps `tab.config.worktree`, so unarchive reattaches it.
9. Settings › Worktrees lists `Active`, `NeedsDecision`, `Kept` rows and `Removed` rows younger than 7 days. `NeedsDecision` offers **Discard and remove** and **Keep worktree**; `Kept` offers **Discard and remove**.
9b. Discard or Keep on a row a pane reattached to `Active` after the page rendered fails with `LedgerStateChanged`, and the page shows the current state.
9c. `Removed` rows older than 7 days are deleted at plugin start (tested with `TestClock`); a plugin that stays loaded for weeks does not prune again until the next start, which is accepted.
10. Reattaching a worktree whose row is `Removed`, `Kept` or `NeedsDecision`, or that has no row, re-adds it if needed and sets the row `Active`.
11. While no `ProviderIssues` is lent to the dispatcher, no `issue_worktrees` row changes.
12. A project's switch survives its removal and re-adding with the same `ProjectId`; while it is removed, its issues leave the sets and `retain` releases their worktrees.

## Interface

### `GitOps` (seam `src/host/services/worktrees-seam.ts`, key `WorktreesKey`)

```ts
/** Who a worktree serves: the pane whose session runs in it, and the text Settings › Worktrees shows. */
export const WorktreeOwner = Schema.Struct({ paneId: PaneId, label: Schema.String })
export type WorktreeOwner = typeof WorktreeOwner.Type

export const WorktreeReleased = Schema.TaggedStruct('WorktreeReleased', {})
export const WorktreeKept = Schema.TaggedStruct('WorktreeKept', { changedFiles: Schema.Int })
export const ReleaseOutcome = Schema.Union([WorktreeReleased, WorktreeKept])
export type ReleaseOutcome = typeof ReleaseOutcome.Type

export interface GitOps {
  readonly createWorktree: (
    sourceRepo: string,
    owner: WorktreeOwner,
    nameHint: Option.Option<string>
  ) => Effect.Effect<WorktreeInfo, WorktreeCreateError>
  readonly reattachWorktree: (info: WorktreeInfo, paneId: PaneId) => Effect.Effect<WorktreeInfo, WorktreeReattachError>
  readonly releaseWorktree: (info: WorktreeInfo, paneId: PaneId) => Effect.Effect<ReleaseOutcome>
  readonly findIncludedFiles: …   // unchanged
  readonly copyIncludedFiles: …   // unchanged
}
```

- `createWorktree`: `nameHint` is free text; the plugin slugifies it (lowercase, `[a-z0-9-]`, at most 40 characters), appends `-<4 hex>` when a directory or branch with that name exists, and generates adjective-noun when `None`. Branch `dia/<slug>`, directory under the plugin's root. Writes the row `Active`.
- `reattachWorktree`: today's contract. Writes the row `Active`, adopting a worktree with no row under label `Pane <paneId>`.
- `releaseWorktree` replaces `removeWorktree`. It runs `git worktree remove <path>` without `--force`; git refuses a tree with modified or untracked files (exit 128, `contains modified or untracked files`; probed on git 2.47.1), so the check and the removal are one step. On a non-zero exit it runs `git status --porcelain` in the path: one or more lines → `WorktreeKept{changedFiles}`; no lines or a failing `git status` (an empty unregistered leftover, `docs/reasoning/2026-10-24-…`) → today's prune and leftover-directory steps → `WorktreeReleased`. A missing path → `WorktreeReleased`. A row that is not `Active` is returned as its recorded outcome (`Removed` → `WorktreeReleased`; `NeedsDecision` or `Kept` → `WorktreeKept` with the stored `changedFiles`) and not changed, so `Kept` never returns to `NeedsDecision`. It never fails.
- `gitOperations` / `hasGitOperations` swap `removeWorktree` for `releaseWorktree`.
- Every ledger write for one path runs under that path's lock (one `Semaphore` per path, held in the plugin; entries are never removed, one per worktree path seen in this run).

### Ledger calls (`plugins/worktrees/calls.ts`, served by `host.ts`, read by `settings-page.tsx`)

`calls.ts` holds `LedgerState`, `LedgerEntry`, `LedgerStateChanged` and the three Rpcs, as `plugins/mcp/calls.ts` does; `WatchWorktrees` is a streaming Rpc (`stream: true`, as `WatchServers`).

```ts
WatchWorktrees: {} → Stream<ReadonlyArray<LedgerEntry>>
DiscardWorktree({ path }): NeedsDecision | Kept → git worktree remove --force; on a non-zero exit (for example a missing directory) the prune and leftover-directory steps; never deletes the branch → Removed
KeepWorktree({ path }): NeedsDecision → Kept
```

Both fail with `LedgerStateChanged{ path, state }` when, under the lock, the row is not in a state the call accepts (for example a pane reattached it to `Active` after the page rendered).

At plugin start, `Removed` rows older than `Duration.days(7)` (by `Clock`) are deleted.

### Org

```ts
export const IssueDirectory = Schema.TaggedStruct('IssueDirectory', { path: Schema.String })
export const IssueWaiting = Schema.TaggedStruct('IssueWaiting', { reason: Schema.String })
export const IssueCwd = Schema.Union([IssueDirectory, IssueWaiting])
export type IssueCwd = typeof IssueCwd.Type

/** Where org issues run, and the worktrees they hold. */
export interface IssueWorkspace {
  /** The directory a picked issue's session runs in, creating or reattaching its worktree. */
  readonly open: (issue: Issue, objective: Objective) => Effect.Effect<IssueCwd>
  /** Releases the worktree of every issue not in `issueIds`, once each. */
  readonly retain: (issueIds: ReadonlySet<IssueId>) => Effect.Effect<void>
}
```

- `ProjectDirectory` stays the query for registration, `sessionTools.forDefinition` and `disabledPermissionModes`.
- `open`: switch off or `isGitRepo` false → `IssueDirectory(projectDir)`. Otherwise inside `whenProvided([WorktreesKey])`: a stored row → `reattachWorktree`; none → `createWorktree(projectDir, { paneId: issue.paneId, label: 'Issue · ' + issue.title }, Option.some(issue.title + ' ' + issue.id.slice(0, 8)))`, then `findIncludedFiles` / `copyIncludedFiles`, then store the row. The `issue_worktrees` row (`released = 0`) is stored immediately after `createWorktree` returns, before the include-file copy; a copy failure is logged and does not fail `open`. A crash between `createWorktree` and the store leaves a ledger `Active` row no issue knows; this is accepted and visible on Settings › Worktrees. Plugin not provided, `ServiceWithdrawnError`, or `WorktreeCreateError` → `IssueWaiting` and a log. `WorktreeReattachError` with cause `Branch … no longer exists` → delete the row and create a fresh worktree; the resumed session then ends `SessionNotFound` (`plugins/claude-code/session.ts` ~422 maps "No conversation found with session ID" to it) and `onEnded` clears the session (`keepSession = end._tag !== 'SessionNotFound'`). Unverified: that the Claude CLI reports that message when the session exists under another cwd's project; it relies on the CLI's per-cwd session lookup. Other `WorktreeReattachError` → `IssueWaiting`.
- `retain`: for each row with `released = 0` not in the set, `releaseWorktree`; set `released = 1` on an outcome; with no plugin, leave `released = 0` so the next pass retries. A row with `released = 1` is kept, so its branch name is reused on reattach (criterion 4). `open` on a released row sets `released = 0`.
- Dispatcher: `startIssue` calls `open` for each issue in `pick.start` before `runs.markStarted`, outside `updateIssues` (the reserved slot is held while `open` runs git). `IssueWaiting` drops the reservation **without** signalling and logs once per issue; the next pass comes from the existing triggers or from a new `ctx.whenProvided([WorktreesKey], …)` in `org/host.ts` that signals the dispatcher when the worktrees plugin is provided. When `markStarted` returns false after `open` succeeded, the worktree stays and the next `retain` releases it if the issue left the sets. Each pass calls `retain` with the ids of `startable` and `started` after `reconcile`, only when `ProviderIssues` is lent; with none lent, no row changes.
- `makeIssueWorkspace` takes `projectOf: (projectId) => Effect<Option<{ directory, isGitRepo }>>`, built in `org/host.ts` beside `directoryOf` from the followed `Workspace`; the dispatcher never sees `isGitRepo`. `followWorkspace`'s `changesWith` key includes `isGitRepo`. The plugin root for new worktrees is `path.join(ctx.dataDir, 'trees')` in the worktrees plugin (`ctx.dataDir` is `<userData>/plugins/worktrees`, `src/host/plugins/host-plugins.ts:77`).
- `OrgSnapshot` (`org/calls.ts`) gains `worktreeProjects: ReadonlyArray<ProjectId>`, filled by the `ReadOrg` serve; new call `SetProjectWorktrees({ projectId, enabled })` follows `SetOverallCap` (`useOrgCall(…, 'worktreeProjects')`). The org settings page lists projects with `isGitRepo` true from the renderer's workspace and shows one switch each. `SetProjectWorktrees` is the only writer of `project_worktrees`; a row for a project absent from the workspace is kept and ignored (`projectOf` is `None`).
- The missing-branch recovery in `open` is best effort (it relies on the unverified CLI behaviour above); verify-in-app checks it by deleting an issue's branch.

## Key Data Structures

```ts
export const Active = Schema.TaggedStruct('Active', {})
export const NeedsDecision = Schema.TaggedStruct('NeedsDecision', { changedFiles: Schema.Int })
export const Kept = Schema.TaggedStruct('Kept', { changedFiles: Schema.Int })
export const Removed = Schema.TaggedStruct('Removed', {})
export const LedgerState = Schema.Union([Active, NeedsDecision, Kept, Removed])
export const LedgerEntry = Schema.Struct({ info: WorktreeInfo, owner: WorktreeOwner, state: LedgerState, updatedAt: Schema.Number })
export type LedgerEntry = typeof LedgerEntry.Type
```

Ledger table: `worktrees(path PRIMARY KEY, branch, source_repo, pane_id, label, state, changed_files, updated_at)`; `changed_files` is non-null exactly for `NeedsDecision` and `Kept` (CHECK constraint).

Org: `project_worktrees(project_id PRIMARY KEY)` (presence = on); `issue_worktrees(issue_id PRIMARY KEY, path, branch, source_repo, released INTEGER NOT NULL DEFAULT 0)`.

## Internal Decomposition

- **worktrees/git-ops.ts** — git commands, including the non-force remove and `git status --porcelain`.
- **worktrees/ledger.ts** — the ledger table, its per-path locks and state transitions; the only writer.
- **worktrees/host.ts** — composes git-ops and the ledger into `GitOps`; serves the ledger calls.
- **worktrees/settings-page.tsx**, **renderer.ts**, **calls.ts** — Settings › Worktrees; the renderer imports `SettingsPagesSlot` from `@dia-plugin/settings/slots`, as `plugins/mcp/renderer.ts` does.
- **org/issue-workspace.ts** — `project_worktrees`, `issue_worktrees`, `open`, `retain`.
- **org/dispatcher.ts** — calls `open` for picked issues and `retain` each pass.

## Design Rationale

**The worktrees plugin owns the ledger** — panes and issues both create worktrees; one owner gives one page and one release rule. Callers keep the `WorktreeInfo` they resume from (tab config, `issue_worktrees`) and never read the ledger (Information Hiding).

**Release when an issue leaves the org's sets** — `reconcile` (`dispatcher.ts` ~515) and `ProviderIssues.runState` (`issues/service.ts:76`) only tell the org which issues are startable or started, not why one left. Releasing for any reason is safe: the branch stays, a dirty tree stays, and `reattachWorktree` restores the worktree if the issue returns to `todo`.

**`retain` instead of a per-issue release** — the dispatcher does not know which issues hold worktrees; it passes the set it already has (Law of Demeter).

**`open` only for picked issues** — `contextsFor` runs before the cap; creating there would create one worktree per `todo` issue.

**Non-force remove** — git's own refusal is the dirty check, so no window exists between check and removal. Only the user's Discard forces (Define Errors Out of Existence).

**`nameHint` as free text** — slug rules, length and ref safety are git knowledge the worktrees plugin owns.

**Owner on create only** — the label is known where the worktree is created; reattach and release find the row by path.

## Implementation notes

Decisions the code made where this spec was silent or could not be followed as written:

- `open` returns `IssueWaiting` when `projectOf` is `None`. `ServiceWithdrawnError` never reaches `open`: `whenProvided` closes its scope before the provider closes, so the held `GitOps` is `None` and `open` returns `IssueWaiting` for a missing plugin.
- The missing-branch case matches the cause string `Branch <branch> no longer exists` exactly; any other `WorktreeReattachError` is `IssueWaiting`.
- `retain` passes the issue id as `releaseWorktree`'s `paneId`. The ledger finds rows by path, so the id appears only in logs.
- `releaseWorktree` on a missing path takes the normal path (non-zero remove, failing `git status`, prune) and returns `WorktreeReleased`; there is no separate existence check.
- `releaseWorktree` with no ledger row writes nothing for `WorktreeReleased` and adopts the row as `NeedsDecision` with label `Pane <paneId>` for `WorktreeKept`.
- `DiscardWorktree` and `KeepWorktree` on a path with no row fail with `LedgerStateChanged{ state: Removed }`.
- `makePaneWorkspaceLive(worktreesRoot)` is now the constant layer `PaneWorkspaceLive`.
- Known limit: when `git worktree remove` fails for a reason other than changed files (for example a locked file on Windows) and the directory still holds files, the row becomes `Removed` while the directory stays. No file is deleted: the leftover step deletes only an empty directory.

## Rejected Alternatives

- A pre-close hook on `AssigneeProvider` to ask before Finish — grows the generic issues contract (ADR-0072).
- Rows on the org Dashboard — the user asked for one page owned by the worktrees plugin.
- Ledger for org issues only — the user chose panes too.
- `git status` then `remove --force` — a window between check and removal.
- Opening worktrees in `contextsFor` — before the cap (round 1, B1).

## Refinement Record

**Round 1 — applied**
- B1 (Correctness, CQS): worktrees opened for every startable issue → `open` only for `pick.start`.
- B2 (Information Hiding, Demeter): dispatcher released per issue → `IssueWorkspace.retain(set)`.
- B3 (project rules, Information Hiding): hand-written `IssueCwd` exposing `WorktreeInfo` → schema union of path or waiting; error mapping and missing-branch rule written.
- B4 (Correctness): criterion 8 conflicted with `pane-workspace.removeWorktree` failing on a kept directory → kept counts as handled; `force` out of scope.
- B5 (Define Errors Out of Existence): status-then-force race → non-force remove; ignored-file limit stated.
- M1: owner on every method, no label at the supervisor → owner on create only; adopt rows as `Pane <paneId>`.
- M2: caller slugified → `nameHint`.
- M3: missing wiring → `whenProvided`, plugin-api exports, `hasGitOperations`, API version bump, renderer entry.
- M4: ledger races → per-path lock, `LedgerStateChanged`, release on non-`Active` writes nothing.
- M5: org skipped `.worktreeinclude` → org copies include files.
- M6: `worktreesRoot` footprint listed; root moves.
- m1–m8: schema `LedgerState`; citations; Discard on `Kept`; 7-day prune of `Removed`; `released` retry and reuse; warning once per issue; ADR amends 0062 and 0072; logging and `Clock`.

**Round 2 — applied**
- B1 (Correctness): `IssueWaiting` through `unreserve` signalled, and the sliding signal queue re-ran the pass in a loop → drop without signalling; signal on `WorktreesKey` provided.
- B2 (Define Errors Out of Existence): `retain` with no lent issues saw empty sets and released every row → `retain` runs only while `ProviderIssues` is lent.
- M1: crash and lost-race windows → store the row right after create; include copy non-fatal; lost race left to `retain`; `open` outside `updateIssues`.
- M2: `PaneWorkspace.removeWorktree` failed archive, delete and Remove Project on a kept tree → `WorktreeKept` is success; quit order cited.
- M3: no pane label source → `label` on `WorktreeRequest.Create`; panes keep generated names.
- M4: Discard on a missing directory → prune fallback; branch never deleted.
- m1: `Kept` lost `changedFiles` → `Kept` carries it.
- m2: semaphore map lifetime stated. m3: `LedgerStateChanged` on Keep confirmed needed. m4: pre-ledger unreattached worktrees out of scope. m5: `SessionNotFound` mechanism cited; CLI per-cwd lookup marked unverified.

**Round 3 — applied**
- M1 (Define Errors Out of Existence): `project_worktrees` on project removal unstated → rows kept and ignored; criterion 12.
- M2 (Law of Demeter): `open` had no source for `isGitRepo` → `projectOf` in `org/host.ts`; `isGitRepo` in the `changesWith` key.
- M3 (plugin import boundary): `LedgerEntry` module unnamed, `WorktreeOwner` in a host file → `calls.ts` holds the ledger schemas; `WorktreeOwner` in `src/shared/domain/pane.ts`, exported through `@dia/plugin`.
- m1: field belongs on `OrgSnapshot`; page and call pattern named.
- m2: criteria added for the plugin-provided restart (5), `LedgerStateChanged` (9b), prune (9c), no lend (11).
- m3: plugin root named (`ctx.dataDir/trees`).
- m4: missing-branch recovery marked best effort, checked in the app.

**Round 2 — rejected**
- m6: "declare the `settings` dependency in `plugin.json`" — `plugins/mcp/plugin.json` has no dependency field; the renderer import is the only requirement.
