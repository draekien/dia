# Archive and delete agents

Scope: layer. Plan step 3 of `docs/plans/2026-10-23-agent-os.md`, issue #14. One PR, stacked on #128.

Governing decisions: ADR-0023 (Archive and Delete rows), ADR-0046 (dia keeps the harness's transcripts), ADR-0043 (workspace in `host.db`). Visual rules: `DESIGN.md` (Agent Overview).

## Success criteria

1. Archiving an agent stops its session, removes its worktree directory and git registration, keeps its branch and every transcript, and moves its row into the project's collapsed "Archived" list.
2. Deleting an agent stops its session, removes its worktree, removes its `agents`, `agent_worktrees` and `agent_sessions` rows from `host.db`, and removes its row. Its transcripts stay under `~/.claude/projects/`.
3. Opening an archived agent shows its current session's transcript with no composer and starts no session.
4. When removing the worktree fails, the agent is neither archived nor deleted, the reason is shown, and the action can be tried again.
5. Archived state, and the absence of deleted agents, survive a restart.
6. Across repeated archive and delete cycles with worktree agents, `git worktree list` and the worktrees directory hold no worktree of an archived or deleted agent.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Transcripts on delete | Kept; no `deleteSession` call. The issue comment's `deleteSession` per `agent_sessions` row is not done | ADR-0046 (accepted after the comment) removed `AgentBackend.deleteSession` and states that deleting one agent keeps its transcripts |
| Branch on archive and delete | Kept | Project removal keeps branches; the branch holds the agent's committed work |
| Restore (unarchive) | Not offered | The worktree is gone and the tab's `cwd` is its old path, so resuming needs a worktree reattach from the branch and a new restore flow; not nearly free |
| Viewing an archived agent | `visibleTab` may name an archived tab; the Host never starts an archived tab's session; the chat plugin renders it read-only | Reuses `SelectTab`, the content header and `getPaneHistory`; no second view state in the renderer |
| Failure | No "anyway" option; the tab stays as it was (session stopped) and the dialog offers "Try again" | One agent has one removable item; a forced drop would leave an orphaned worktree, which criterion 6 forbids |
| Confirmation | Delete always confirms in an `AlertDialog`. Archive confirms only for an agent with a worktree, because `git worktree remove --force` discards uncommitted changes | Destructive steps confirm; archiving an agent without a worktree removes nothing |
| Archived list | Each project group ends with an `Archived · n` disclosure, collapsed by default; "Show archived agents" opens every list | The issue asks for a collapsed list; the existing filter keeps a meaning |
| Plugin API version | Not bumped | Only the renderer plugin `actions` gain members; precedent (#118, #119, #110) adds renderer exports without a bump. `@dia/plugin` is unchanged |

## Interface

### Shared domain — `src/shared/domain/project.ts`

```ts
/** Archiving or deleting a tab could not remove its worktree; the tab is unchanged. */
export class WorktreeNotRemovedError extends Schema.TaggedError<WorktreeNotRemovedError>()(
  'WorktreeNotRemovedError',
  { paneId: Schema.String, path: Schema.String, reason: Schema.String }
) {}
```

`Workspace` drops its "the visible tab is archived" check; the `Tab` JSDoc changes to "archived tabs are listed in the project's archived list and never run".

### Shared domain — `src/shared/domain/workspace.ts`

- `selectTab` accepts an archived tab.
- `archiveTab(workspace, paneId): Result<Workspace, TabNotFoundError>` sets `archived: true` and removes `config.worktree`; `config.cwd` keeps the old path, because the transcript is keyed by it. `visibleTab` is unchanged.
- `deleteTab(workspace, paneId): Result<Workspace, TabNotFoundError>` drops the tab. When it is the visible tab, `visibleTab` becomes the first non-archived tab of the same project, else of any project, else `null`.

### Host — `PaneWorkspace`

```ts
readonly archiveTab: (paneId: PaneId) => Effect<void, TabNotFoundError | WorktreeNotRemovedError>
readonly deleteTab: (paneId: PaneId) => Effect<void, TabNotFoundError | WorktreeNotRemovedError>
```

Both: mark the pane retiring (in memory; `selectTab`, `resumePane` and `ensureLive` treat it as they treat a tab of a project being removed), `supervisor.closePane(paneId)`, then remove the worktree with the helper Remove Project uses (success once the path is gone; `WORKTREES_PLUGIN_NOT_LOADED` when the plugin is absent), then apply the pure operation and save. `WorkspaceStore.save` deletes the agent's rows for a deleted tab (`deleteGone` and `ON DELETE CASCADE`) and the `agent_worktrees` row for an archived one (`writeWorktrees`). A failed worktree removal fails with `WorktreeNotRemovedError` and leaves the workspace unchanged. A tab whose project is being removed fails with `TabNotFoundError`. `startPaneSession` returns without starting for an archived tab. A second call for a pane that is already retiring fails with `TabNotFoundError`.

### Host — `WorkspaceStore`

`load` restores `visible_agent` when it names any loaded tab, archived or not, so an open archived agent is still open after a restart.

### RPC — `PROTOCOL_VERSION` 0.0.16 → 0.0.17

`ArchiveTab { paneId }` and `DeleteTab { paneId }`, queries with `error: WorktreeNotRemovedError`. The handler maps `TabNotFoundError` to success with a log, because a tab already gone needs no action.

### Preload and renderer

`DiaApi.archiveTab(paneId)` / `deleteTab(paneId)`: `Promise<string | null>`, the failure reason or `null`. Renderer `actions.archiveTab` / `actions.deleteTab` forward them.

- `plugins/agent-overview/agent-row.tsx`: row menu gains Archive (non-archived rows) and Delete…, separated as destructive.
- `plugins/agent-overview/retire-agent-dialog.tsx`: `AlertDialog` for both actions. Body lists what is removed (the session, the worktree path, and for delete dia's record of the agent) and what stays (the branch, the transcripts under the Claude Code projects directory). While running, the action button reads "Archiving…"/"Deleting…"; on failure the reason shows with "Try again".
- `plugins/agent-overview/overview.ts`: `archived` always holds the matching archived rows; `navigationOrder` takes the set of projects whose archived list is open and adds an `ArchivedTarget` (the disclosure) before those rows.
- `plugins/chat/chat.tsx`: an archived tab renders `ArchivedTranscript` (`plugins/chat/archived-transcript.tsx`): the messages from `paneChatAtom` through `MessageView`, without rewind, composer or settings, above a caption "Archived. This transcript is read-only."

## Not changed

- Remove Project. Agent summaries (an archived tab reads idle). The Host plugin API.

## Refinement record

Runner: inline (the task allows no subagents besides the review passes). Effort: medium.

| Round | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | `WorkspaceStore.load` keeps `visible_agent` only for an unarchived tab, so an open archived agent would be lost on restart (criterion 5) | major | Applied: `load` restores any loaded tab |
| 1 | A second archive or delete of a pane already retiring has no defined result | minor | Applied: fails with `TabNotFoundError`, which the RPC handler treats as done |
| 1 | `WorktreeNotRemovedError.paneId` is a plain string, not `Uuid` | minor | Rejected: matches `TabNotFoundError`, which the same RPCs already carry |
| 1 | The archived disclosure as a navigation target adds a target type | minor | Rejected: without it the disclosure is unreachable with the arrow keys the overview uses |
| 2 | None standing | - | Stopped early |
