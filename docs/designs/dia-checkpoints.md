# `dia-checkpoints` plugin

Issue: draekien/dia#249, step 11 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0076 ("Diffs and checkpoints" row). Builds on `dia-git` (`docs/designs/dia-git.md`, D8).

`dia-checkpoints` records the working tree of each run as a git snapshot when a turn starts and when it ends, and shows, in a `Changes` panel of the chat right panel (`docs/designs/right-panel.md`), each turn of the run with the files it changed and each file's diff. The panel first shipped as a session rail card (PR #264) and moved to the right panel for issue #139. The name `dia-checkpoints` is the issue's provisional name and is kept. Elsewhere in dia "checkpoint" names the Agent SDK's rewind point (`RewindToCheckpoint`, ADR-0045); this plugin calls its records *turn snapshots*.

## Success criteria

1. Each run lists the files it changed per turn. (Test: `checkpoints.test.ts` over a real repo: `beginTurn`, a modified tracked file and a new untracked file, `endTurn`; `turns` returns one finished turn whose files are those two with their line counts, and the repo's index, `HEAD` and `git status` are unchanged. App: send a turn that makes the agent edit a file through Bash; the `Changes` panel lists the file under that turn, and the turn header reads `1 file +N −N`.)
2. Each file's diff is shown per turn. (Test: `fileDiff(turn, path)` returns the patch of that file between the turn's two snapshots, and only that file. App: open the file row in the panel and see its patch.)
3. A turn that never received an end ends at the next turn's start, and a later end replaces an earlier one. (Test: `beginTurn` twice gives a first turn ending at the second's start snapshot; `endTurn` twice keeps the second snapshot.)
4. Turn boundaries come from the run's events. (Test: `boundaryOf` maps `PaneUserMessagesSent` to a start with the first message's first line, `PaneAttentionChanged` to `Completed`, `Errored`, `Crashed` and each parked state to an end, and `Idle`, `AwaitingPermission` and every other event to nothing.)
5. A run whose directory is not in a git repository shows `Not a git repository`. (Test: `host.test.ts` follows a run in a plain temporary directory and receives `NotARepository`. App: a session in a folder outside any repository shows the line in the panel.)

## Decisions taken without the user

D1. **How turn snapshots relate to the Agent SDK's file rewind (ADR-0045): they are separate, and snapshots are read-only.** Rewind keeps using `rewindFiles` with the user turn's uuid and `resumeSessionAt` (ADR-0045, `docs/reasoning/2026-07-19-file-checkpoint-rewind-uuid-composition.md`); `dia-checkpoints` neither restores files nor takes part in a rewind. Reasons: the SDK's checkpoints expose no diff or file list, and track only edits made through Write, Edit and NotebookEdit in the main conversation, not Bash commands or subagent edits (SDK docs, "File checkpointing › Limitations", read 2026-11-13); a git snapshot of the working tree records every change whoever made it, which "files it changed" needs. After a rewind the next turn's start snapshot holds the rewound tree, so later turns' diffs stay correct. The turns the rewind discarded stay listed under their own prompts, because their changes happened and a rewind does not undo Bash changes. Alternative: restore files from the snapshot on rewind (t3code `restoreCheckpoint`) (rejected: it would also revert the user's own edits and other runs' edits in a shared directory, and replace an accepted ADR's mechanism without a reported problem). Alternative: drop the discarded turns on `PaneRewoundToCheckpoint` (rejected: the event names a message uuid, and nothing maps that uuid to a turn number without a second store).

D2. **Snapshots are commits stored under refs in the run's repository, `refs/dia/checkpoints/<runId>/<turn>/start` and `…/end`, and the refs are the only store.** A snapshot stages the working tree (tracked files and untracked files `.gitignore` does not exclude) into a temporary index that starts as a copy of the repository's index, so unchanged files are not rehashed, writes a tree and a parentless commit as a fixed author (`dia`, `dia@localhost`) without signing, and points the given refs at it. The real index, `HEAD`, branches and the working tree are not touched. Refs outside `refs/worktree/`, `refs/bisect/` and `refs/rewritten/` are shared by all worktrees of a repository (git-worktree docs), so the records survive a released worktree. The start commit's message is the turn's prompt (first line of the first message, at most 120 characters), which the panel shows. Turn numbers start at 1 and are one more than the run's highest. Alternative: a database table of turns (rejected: it would duplicate what the refs hold and could disagree with them). Alternative: t3code's commit with `HEAD` as parent (rejected: dia has no use for authored-path detection yet).

D3. **A turn starts at `PaneUserMessagesSent` and ends at a `PaneAttentionChanged` to `Completed`, `Errored`, `Crashed` or a parked state; an end always replaces the latest turn's end.** `Idle` is not an end, because `dia-runs` sets `Idle` mid-turn after a request is answered or a message steers (`live-run.ts`, `answered`, `sendMessage`). Replacing covers two cases: a parked turn that resumes and later completes ends at completion; and if a steered turn's own end arrives after the next turn's `PaneUserMessagesSent` (unverified ordering), the next turn's real end replaces it. A turn still open when the next one starts gets the new start snapshot as its end, which covers interrupts (`interrupt` sets only `Idle`), and a dia restart mid-turn. `PaneUserMessagesSent` is emitted only by a live run (`live-run.ts`), never by transcript catch-up, and every `PaneSignal` is stored in the run's log (`contract.ts`, `PaneSignal`). The snapshot is taken when the event is read, so a change made between the event and the snapshot can fall in the neighbouring turn. Alternative: `Runs.busy` (rejected: a run waiting on a request is not busy, which would split a turn).

D4. **File lists and diffs are computed between a turn's two snapshot commits on request, with rename detection off for the file list.** A renamed file shows as a deleted and an added path. `fileDiff` uses the existing `Git.diff` with both commits and the one path; a pathspec of one path cannot pair a rename. Binary files are listed with no line counts. Each finished turn's file list is cached in memory by its two commit ids, so following a run runs `git diff --numstat` once per finished turn.

D5. **A turn without an end is shown as open, with no files** ("Changes show when this turn ends"). An interrupted turn stays open until the next turn starts. Diffing an open turn would need a snapshot per view. Alternative: diff the start snapshot against the live working tree (rejected: `git diff <commit>` omits untracked files).

D6. **Records are not deleted.** A deleted run's refs stay in its repository, and every snapshot's objects stay reachable until a later step prunes them. Alternative: delete them on `Runs.retire(…, 'deleted')` (rejected: no change stream reports a deletion).

D7. **A run whose directory is not in a git repository has no records**; its snapshot fails with `GitError`, logged at debug level. `FollowRunChanges` reports `NotARepository` when reading the run's refs fails with a `GitError` whose stderr contains `not a git repository` (git's message, which t3code matches the same way in `GitVcsDriverCore.ts`), and the panel shows `Not a git repository`; any other `GitError` reports no turns and the panel shows `No changes yet`. A git installation whose messages are translated reports no turns instead. Runs that share one directory (no worktree) each see the other's changes in their diffs.

D8. **Snapshots run one at a time, in event order, for every run**, in one fiber following `RunEvents.subscribe`. A slow snapshot delays the next run's.

D9. **`GitFileChange` is a schema in `git-seam.ts`, exported from `@dia/plugin`**, used by the seam and by the plugin's call schema, so the shape is declared once (the `RunAnswer` precedent in `runs-seam.ts`).

## Interface

### Kernel seam additions (`src/host/services/git-seam.ts`)

```ts
/** A ref and the subject line of the commit it points at. */
export interface GitRef { readonly name: string; readonly subject: string }

interface Git {
  // …existing members
  /** Records `cwd`'s working tree (tracked files and untracked files `.gitignore` does not exclude) as a parentless commit with `message`, and points every ref in `refs` at it. Leaves the index, `HEAD` and the working tree unchanged; needs no git identity. */
  readonly snapshot: (cwd: string, refs: NonEmptyReadonlyArray<string>, message: string) => Effect.Effect<void, GitError>
  /** The refs whose name starts with `prefix`, in name order. */
  readonly refs: (cwd: string, prefix: string) => Effect.Effect<ReadonlyArray<GitRef>, GitError>
  /** The files that differ between commits `from` and `to`; a rename is a deletion and an addition. */
  readonly changedFiles: (cwd: string, from: string, to: string) => Effect.Effect<ReadonlyArray<GitFileChange>, GitError>
}
```

`GitFileChange` (in `git-seam.ts`): `GitFileChange = Schema.Struct({ path, added: Int, deleted: Int, binary: Boolean })` — line counts are 0 when `binary`.

`GIT_MEMBERS` gains the three names. `makeGit`'s `run` takes an optional environment merged over `GIT_TERMINAL_PROMPT=0`; `snapshot` passes `GIT_INDEX_FILE` inside a `FileSystem.makeTempDirectoryScoped` directory and `-c core.splitIndex=false`. `makeGit` then requires `FileSystem` and `Path` besides `ChildProcessSpawner`; every caller provides `NodeServices.layer` or both services. `docs/designs/dia-git.md` is updated to match.

### Plugin (`plugins/dia-checkpoints`)

`plugin.json`: `category: feature`, `host: host.ts`, `renderer: renderer.ts`, `load: eager`; it exports no module (its own renderer imports `calls.ts`, as `dia-inbox` does).

`calls.ts` (each export documented):

```ts
/** A turn still running, or interrupted with no later turn: its number and prompt. */
export const TurnOpen = Schema.TaggedStruct('TurnOpen', { turn: Schema.Int, prompt: Schema.String })
/** A finished turn with the files it changed. */
export const TurnFinished = Schema.TaggedStruct('TurnFinished', { turn: Schema.Int, prompt: Schema.String, files: Schema.Array(GitFileChange) })
/** One turn of a run, open or finished. */
export const TurnChanges = Schema.Union([TurnOpen, TurnFinished])
/** Run `runId`'s turns could not be read: git, runs or run events are not provided, the run is unknown, or git failed. */
export class ChangesUnavailable extends Schema.TaggedErrorClass<ChangesUnavailable>()('ChangesUnavailable', { runId: Schema.String }) {}
/** Run `runId`'s turns in order, now and after each snapshot of the run; empty while the services are not provided or the run has no records. */
/** A run's turns in order; empty while the services are not provided or the run has no records. */
export const RunTurns = Schema.TaggedStruct('RunTurns', { turns: Schema.Array(TurnChanges) })
/** The run's directory is not in a git repository (D7). */
export const NotARepository = Schema.TaggedStruct('NotARepository', {})
export const RunChanges = Schema.Union([RunTurns, NotARepository])
/** Run `runId`'s changes, now and after each snapshot of the run. */
export const FollowRunChanges = Rpc.make('FollowRunChanges', { payload: { runId }, success: RunChanges, stream: true })
/** The patch of `path` in finished turn `turn` of run `runId`. */
export const GetFileDiff = Rpc.make('GetFileDiff', { payload: { runId, turn, path }, success: Schema.String, error: ChangesUnavailable })
```

### Internal modules

- `checkpoints.ts` — `makeCheckpoints(git)` returns the turn record of any run, given its id and directory; owns the ref layout and the file-list cache. `beginTurn(runId, cwd, prompt)`, `endTurn(runId, cwd)` (does nothing when the run has no turn), `turns(runId, cwd)` and `fileDiff(runId, cwd, turn, path)`.
- `boundaries.ts` — `boundaryOf(event: StoredEvent): Option<Boundary>`, `Boundary = TurnStart { prompt } | TurnEnd`: whether a stored run event starts or ends a turn.
- `host.ts` — inside `ctx.whenProvided([RunsKey, RunEventsKey, GitKey])`: subscribes, maps each committed event to a boundary, looks up the run's `cwd` with `Runs.list`, calls `beginTurn`/`endTurn`, then publishes the run id to a `PubSub`; the calls read the current services from a `SubscriptionRef` (the `dia-inbox` precedent), so outside that scope `FollowRunChanges` emits `RunTurns` with no turns and `GetFileDiff` fails `ChangesUnavailable`.
- `changes-panel.tsx`, `renderer.ts` — a `PanelsSlot` entry `Changes` (order 40) for every chat tab: turns newest first, separated by hairlines; each turn header shows `Turn N`, the prompt and, for a finished turn with files, `2 files +14 −3` (`1 file` in the singular; binary files count as files with no lines). File rows show the file name, its folder muted and `+added −deleted` (`Binary`); a row expands to its patch, fetched with `GetFileDiff`, with added and deleted lines coloured and no height cap, because the panel body scrolls. Empty states: `No changes yet`, `Not a git repository`.

## Refinement Record

**Round 1 (subagent) — applied**
- *Correctness, blocker* — `commit-tree` needs an identity; fixed author, no signing (D2).
- *Correctness, blocker* — `run` needs an environment parameter for `GIT_INDEX_FILE` (seam section).
- *Correctness, blocker* — a parked turn resumes without a new start; an end now replaces the latest end (D3).
- *Correctness, major* — an interrupt leaves a turn open; the card says so (D5).
- *Correctness, major* — steer ordering is unverified; the replace rule covers it (D3).
- *Efficiency, major* — file lists cached per finished turn (D4).
- *Performance, major* — temporary index starts as a copy of the real one (D2).
- *Deep Modules, major* — `setRef` folded into `snapshot(cwd, refs, message)`.
- *Project rules, major* — `GIT_MEMBERS`, `dia-git.md` and `git.test.ts` updates; `GitFileChange` declared once as a schema (D9).
- *Minor* — `ChangesUnavailable` and module contracts documented; "turn snapshot" naming; unbounded growth stated (D6); D3 cites where events come from.

**Round 1 — rejected**
- *Pass `--no-renames` through `diff`'s revisions* — rejected: a single-path pathspec cannot pair a rename, so the existing `diff` needs no flag (D4).

**Round 2 (inline) — no blocker or major finding.** Minor, rejected: the file-list cache grows with every finished turn read in the session (rejected: one entry is a few paths per turn; a later step can bound it). Rounds stopped early after round 2.
