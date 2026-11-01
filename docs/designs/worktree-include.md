# Worktree include files and tab setup progress

Scope: module. Issue #78, plan step 5 of the agent OS stack (#10). One PR, stacked on #130.

Copies the gitignored files a project's `.worktreeinclude` matches into every tab worktree dia creates or reattaches, and shows the tab's setup steps while that happens.

Governing decisions: ADR-0019 (worktree git work stays in the `worktrees` plugin), ADR-0021 (one Host process), ADR-0031/0040 (the chat plugin fills the tab slot). Matching findings: `docs/reasoning/2026-11-01-worktreeinclude-matching-with-git.md`.

## Success criteria

1. A new worktree tab and a resumed worktree tab contain every gitignored file `.worktreeinclude` matches; no tracked file and no untracked-but-not-ignored file is copied; an existing destination file is left unchanged.
2. A project without `.worktreeinclude` copies nothing and shows no copy step.
3. On create and on resume the tab body shows the steps `Create worktree` (or `Reattach worktree`), `Copy N files`, `Start Claude Code session`, each pending, running, done or failed; the copy step can be a warning.
4. A file that cannot be copied leaves the tab running; the copy step shows the warning, and the transcript records it as a notice.
5. A worktree failure shows on the failed step and keeps today's `WorktreeCreateError` / `WorktreeReattachError` handling.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| How files are matched | `git ls-files -z --others --ignored --exclude-from=<repo>/.worktreeinclude`, piped to `git check-ignore -z --stdin`, run in the project directory | git applies its own `.gitignore` syntax (negation, `**`, anchoring) and adds no dependency. `--others` drops tracked files and `check-ignore` drops files that are not gitignored. 0.1 s, or 0.48 s with a 100 000-file ignored `node_modules` |
| Nested `.worktreeinclude` files | Not read | `--exclude-from` reads one file; the issue says to follow it. `--exclude-per-directory` would read them |
| `**/` patterns inside a wholly ignored directory | Matched as git matches them (a superset of Claude Code's rule) | `ls-files` with only `--exclude-from` does not know the directory is ignored, so it descends into it. Claude Code skips such files unless the directory or the first name after `**/` is in the path |
| Where the copy runs | Two new `GitOps` operations in the `worktrees` plugin: `findIncludedFiles` and `copyIncludedFiles`. `PLUGIN_API_VERSION` 0.0.13 → 0.0.14 | ADR-0019. Two operations because the supervisor needs to know whether there is a copy step, and its file count, before copying |
| Which tabs show setup steps | Worktree tabs only | The issue keeps tabs without a worktree unchanged |
| Progress transport | A new `PaneSetupProgress` IPC event carrying the whole step list, sent through `openPane`'s `onEvent`. `PROTOCOL_VERSION` 0.0.17 → 0.0.18 | The issue. A whole list per event is replay-safe; the renderer replaces it and needs no merge |
| Where the renderer keeps the steps | `PaneChatState.setup` | The New agent form and the chat pane read the same `paneChatAtom(paneId)`, so the steps survive the switch from form to tab |
| Step rows | `StepStatusIcon` moves from the chat plugin into the kernel and gains `warning`; the chat plugin's tool-call rows and the new `TabSetupSteps` use it, with `Marker` and `formatElapsed` | The issue asks to reuse the chat plugin's step rows; a plugin cannot export to the kernel, so the shared part moves down |
| Elapsed time | Duration shown once a step finishes; no live timer on a running step | A running step shows the spinner dot; a live timer needs a clock per row for steps that take seconds |
| Session failure (#48) | When a resumed session ends with `SessionNotFound`, the session step is sent again as `failed` with the not-found text | #48's recovery UI belongs on that step; the step now exists in a failed state |

## Interface

### `GitOps` (seam, `src/host/services/worktrees-seam.ts`)

```ts
readonly findIncludedFiles: (
  sourceRepo: string,
  paneId: PaneId
) => Effect.Effect<Option.Option<ReadonlyArray<string>>, WorktreeIncludeError>

readonly copyIncludedFiles: (
  worktree: WorktreeInfo,
  files: ReadonlyArray<string>,
  paneId: PaneId
) => Effect.Effect<ReadonlyArray<IncludedFileFailure>>
```

- `findIncludedFiles` returns `None` when `sourceRepo` has no `.worktreeinclude`, otherwise the repo-relative paths (forward slashes) of the untracked files that match it and are gitignored. Fails with `WorktreeIncludeError { paneId, sourceRepo, cause }` when git cannot run.
- `copyIncludedFiles` copies each path from `worktree.sourceRepo` to `worktree.path`, creating parent directories and skipping a path that exists at the destination. It never fails; it returns `IncludedFileFailure { path, reason }` for each file it could not copy.
- `resolveGitOps` requires all five operations.

### IPC (`src/shared/ipc/contract.ts`)

```ts
SetupStepState = 'pending' | 'running' | 'done' | 'warning' | 'failed'
WorktreeSetupStep = TaggedStruct('WorktreeSetupStep', { reattach: boolean, state, branch?, durationMs?, error? })
CopySetupStep     = TaggedStruct('CopySetupStep', { state, files: Array<{ path, error? }>, durationMs?, matchError? })
SessionSetupStep  = TaggedStruct('SessionSetupStep', { state, durationMs?, error? })
SetupStep = Union([WorktreeSetupStep, CopySetupStep, SessionSetupStep])
PaneSetupProgress = TaggedStruct('PaneSetupProgress', { paneId, steps: Array<SetupStep> })
```

Added to `IpcEvent`; the preload adds `onSetupProgress`.

### Host: `PaneSupervisor.openPane`, worktree tabs

1. `findIncludedFiles(sourceCwd)`. `None` leaves the copy step out; `Some` or a failure puts it in.
2. Send the list: worktree step `running`, copy step `pending`, session step `pending`.
3. Create or reattach the worktree: `done` with the branch and duration, or `failed` with the error text, then fail as today.
4. Copy step `running`, then `copyIncludedFiles`: `done` when nothing failed, `warning` with each file's error otherwise. A matching failure makes the step `warning` with `matchError` and copies nothing.
5. Session step `running`, `startPane`, then `done`, sent before the pane's event subscriber starts.
6. A copy warning is then sent through `onEvent` as a `PaneSessionNotice`.
7. A `SessionNotFound` end sends the session step again as `failed`.

`src/host/services/tab-setup.ts` owns the step list: `setUpWorktreeTab(options)` runs steps 1 to 4 and returns the worktree with `startSession(start)` (step 5 and 6) and `failSession(error)` (step 7). Nothing else is exported apart from its option and result types.

### Renderer

- `PaneChatState.setup: ReadonlyArray<SetupStep> | undefined`, replaced by each `PaneSetupProgress` and kept across a history reload.
- `TabSetupSteps({ steps })` (`src/renderer/src/components/tab-setup-steps.tsx`) and `showsSetup(steps)` (true while a step is pending, running or failed), both exported from `@dia/renderer-plugin`.
- Labels: `Create worktree` / `Reattach worktree` (detail: branch), `Copy N files` or `Copy k of N files` when some failed (detail: `.worktreeinclude`), `Start Claude Code session`. Up to 5 files every path is listed, a failed one with ` — reason`; above 5 only the failed paths are listed.
- New agent form: once Start is pressed, mounts `paneChatAtom(paneId)` and shows `TabSetupSteps` above the buttons; it stays after a failure.
- Chat pane: shows `TabSetupSteps` after the transcript while `showsSetup(chat.setup)`.

## Rejected Alternatives

- **A JavaScript gitignore matcher over `ls-files --directory` output** — a second implementation of gitignore syntax and a dependency, to save 0.4 s on a 100 000-file `node_modules`.
- **Copy inside `createWorktree`/`reattachWorktree`** — merges two steps the UI reports separately.
- **One `SetupStep` struct with optional `branch`, `files` and `error`** — admits `files` on a worktree step; a union per step kind does not.

## Refinement Record

Runner inline, effort medium; stopped after round 2.

**Applied**
- *Define Errors Out of Existence* (round 1, major) — one `SetupStep` struct with optional `files` and `detail` admitted files on a worktree step; split into three tagged step structs.
- *Information Hiding* (round 1, major) — `copyStepResult` and `copyWarningNotice` were exported for tests; kept internal and tested through `openPane`.
- *POLA* (round 1, minor) — the copy step's constant `.worktreeinclude` detail moved to the renderer.
- *Correctness* (round 1, minor) — step 1 did not say whether a matching failure shows the copy step; it does.
- *Correctness* (round 1, major) — the order of the final `done` event and the session's events was unspecified; it is sent before the subscriber starts.
- *Names as Documentation* (round 1, minor) — `isSettingUp` returned true for a failed step; renamed `showsSetup`.
- *Names as Documentation* (round 2, minor) — the copy step's `error` only meant a matching failure; renamed `matchError`.

**Rejected**
- *Strategic Programming* (round 1) — `paneId` on the new `GitOps` operations is only used for logs and errors. Rejected: every existing `GitOps` operation takes it for the same reason.
- *Correctness* (round 1) — mounting `paneChatAtom` before the tab exists might fail its history fetch. Rejected after checking: `getPaneHistory` returns `[]` for an unknown tab and `GetMessageQueue` returns the empty queue.
