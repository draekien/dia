# Unarchive an agent and compact its events on archive

Scope: layer. Issue #158, the last sub-issue of #151. Implements "Archive and unarchive" in ADR-0051 and amends `docs/designs/archive-delete-agents.md`.

Archiving records `AgentArchived` and drops the agent's superseded streaming events; unarchiving recreates the agent's worktree from its kept branch and records `AgentUnarchived`, so the agent can be resumed.

## Success criteria

1. Archiving an agent appends `AgentArchived`. Afterwards the agent has no `MessageUpdated` or `ReasoningUpdated` event with `streaming: true` for which a later event of the same item exists. A streaming event with no later event for its item stays.
2. Unarchiving an archived worktree agent runs `git worktree add <path> <branch>` with its original path and kept branch, appends `AgentUnarchived`, clears `agents.archived_at`, and moves its row out of the Archived list. Sending it a message resumes its session in that worktree.
3. Unarchive fails, writes no event, and leaves the agent archived when the branch no longer exists, when the worktree path is a non-empty directory that is not a registered worktree, or (for an agent with no worktree) when its `cwd` no longer exists. The renderer shows the reason in a toast.
4. An archived agent's transcript renders from `agent_items`, tool calls included.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Where the kept branch lives | An archived tab keeps `config.worktree`; `WorkspaceStore` keeps its `agent_worktrees` row | `WorktreeInfo` already holds `path`, `branch` and `sourceRepo`, and `startPaneSession` already turns it into a `Reattach` request (`pane-workspace.ts:785`). `writeWorktrees` deletes the row only when `config.worktree` is absent (`workspace-store.ts:335`), and `load` LEFT JOINs it back. Storing it in `AgentArchived` would need a new store read |
| What compaction deletes | Streaming `MessageUpdated` and `ReasoningUpdated` events superseded by a later event of the same item. `ToolCallStarted` stays | ADR-0051 keeps one final event per message and tool call, and coalesces reasoning like message text. Extends ADR-0051's "Archive and unarchive" bullet, which names only `MessageUpdated`; confirmed with the user. Streaming events carry no `source_uuid` (`agent-event-recorder.ts:339,346`; only final events set it, `:400,433,465`), and the source-uuid unique index is partial on `source_uuid IS NOT NULL`, so deleting them does not change catch-up's idempotency check |
| Where compaction runs | In `AgentEventStore`'s projection of `AgentArchived`, in the transaction that appends it, as one window-function `DELETE` over the agent's rows | ADR-0051: an event insert and its projection commit together. `agent_events` is indexed by `(agent_id, sequence)` only, so a per-row correlated `EXISTS` on `item_id` would rescan the agent's rows once per row |
| Archive order | `closePane`, worktree removal, `AgentArchived`, workspace change | `closePane` joins the session's subscriber fiber before closing its scope (`pane-supervisor.ts:773-774`), so the recorder's final flush is committed before `AgentArchived`, and compaction sees every final event |
| Unarchive check order | Git (or the `cwd` check) first, then `AgentUnarchived`, then the workspace change | ADR-0051 and the issue: "fails with no event written". A failed event write after the worktree exists is logged and the workspace change still runs, as a failed `AgentArchived` write is; `WorkspaceStore.save` writes `archived_at` from the tab |
| Branch-missing reason | `GitOps.reattachWorktree` runs `git rev-parse --verify --quiet refs/heads/<branch>` before `git worktree add` | `git worktree add` exits 128 for a missing branch and `spawner.exitCode` gives no stderr, so the reason would read "git worktree add exited with code 128". Resume gets the same message |
| Branch checked out in another worktree | `git worktree add` fails with the generic `exited with code 128` reason. Not handled | No stderr is captured; dia creates one branch per agent, so this needs a user's manual checkout |
| Agents archived before this change | Unarchive of a tab with no `config.worktree` requires `config.cwd` to exist, else fails with reason `The working directory <cwd> no longer exists`. Unarchive appears on every archived row | Such tabs lost their `WorktreeInfo` and their `cwd` is a removed worktree path, so for them Unarchive always fails with that reason. Confirmed with the user |
| Session after unarchive | Not started; selection unchanged | When the unarchived tab is visible, `chat.tsx` switches from `ArchivedTranscript` to the live chat with no session; the first `SendMessage` calls `ensureLive` (`rpc-handlers.ts:119`), whose `Reattach` request finds the registered worktree and adopts it (`git-ops.ts:240-249`). Selecting another tab and back calls `resumePane`. Confirmed with the user |
| Failure display | Shadcn Base UI toast, mounted once in the renderer | The user chose a toast. The agent-overview `notice` banner was not offered to the user and is not used |
| Paging the archived transcript | Not done | No scope bullet asks for it; confirmed with the user |

## Interface

### Shared domain — `src/shared/domain/workspace.ts`

```ts
/** Archives the tab with `paneId`: marks it archived. Its `config`, worktree included, is kept so it can be unarchived. The visible tab is unchanged. */
export const archiveTab: (workspace: Workspace, paneId: PaneId) => Result<Workspace, TabNotFoundError>

/** Unarchives the tab with `paneId`: marks it not archived. The visible tab is unchanged. Fails for an unknown pane id. */
export const unarchiveTab: (workspace: Workspace, paneId: PaneId) => Result<Workspace, TabNotFoundError>
```

### Shared domain — `src/shared/domain/project.ts`

```ts
/**
 * Unarchiving a tab could not restore its working directory; `path` is the worktree path, or the
 * tab's `cwd` for a tab with no worktree, and `reason` says why. The tab stays archived and no
 * event is written, so the request can be sent again.
 */
export class WorktreeNotRestoredError extends Schema.TaggedError<WorktreeNotRestoredError>()(
  'WorktreeNotRestoredError',
  { paneId: Schema.String, path: Schema.String, reason: Schema.String }
) {}
```

The `Tab` JSDoc (`project.ts:37-38`) changes to say an archived tab has no worktree directory and keeps `config.worktree` so it can be unarchived.

`removalItemsOf(tab)` (`src/shared/domain/project-removal.ts`) lists no `WorktreeItem` for an archived tab, because its worktree directory was removed at archive.

### Host — `AgentEventStore`

Interface unchanged. The `AgentArchived` case of `project` becomes `Effect.andThen(<archived_at update>, <compaction DELETE>)`, so both run inside `appendOne`'s transaction. The DELETE, with `agentId` bound:

```sql
DELETE FROM agent_events WHERE sequence IN (
  SELECT sequence FROM (
    SELECT sequence, event_type,
      json_extract(payload_json, '$.streaming') AS streaming,
      ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY sequence DESC) AS newer
    FROM agent_events WHERE agent_id = ? AND item_id IS NOT NULL)
  WHERE newer > 1 AND streaming = 1 AND event_type IN ('MessageUpdated', 'ReasoningUpdated'))
```

The `append` JSDoc states that appending `AgentArchived` deletes those events. Deleted sequences are never replayed; `readAfter` already treats sequences as non-contiguous.

### Host — `PaneWorkspace`

```ts
/**
 * Unarchives a tab: restores its worktree from its kept branch at its original path (or checks
 * that its working directory exists, for a tab with no worktree), records that it was unarchived,
 * and marks it not archived. Starts no session, and does nothing for a tab that is not archived.
 * Fails with `WorktreeNotRestoredError`, leaving the tab archived with no event written, and with
 * `TabNotFoundError` for an unknown tab or one being archived, deleted or unarchived.
 */
readonly unarchiveTab: (paneId: PaneId) => Effect<void, TabNotFoundError | WorktreeNotRestoredError>
```

`makePaneWorkspaceLive` requires `AgentEventStore`, and its JSDoc (`pane-workspace.ts:209-211`) lists it. `archiveTab` appends `AgentArchived` through `AgentEventStore.append` after the worktree is removed and before the workspace change; a failed append is logged and does not fail the archive.

`unarchiveTab` calls `markRetiring`, then, inside the block that `Effect.ensuring(clearRetiring)` guards, returns without effect (logged) when the tab is not archived. While the pane is retiring, `SelectTab`, `resumePane` and `ensureLive` refuse it (`isRemovingTab`, `pane-workspace.ts:277`), so no session start races the git step. Then: with `config.worktree`, it resolves `GitOps` (reason `WORKTREES_PLUGIN_NOT_LOADED` when absent) and calls `reattachWorktree`, mapping its `cause` to `reason` as `typeof cause === 'string' ? cause : String(cause)`; without, it checks `fs.exists(config.cwd)`. On success it appends `AgentUnarchived` (failure logged) and applies `WorkspaceOps.unarchiveTab`.

### Worktrees plugin — `GitOps.reattachWorktree`

Before `git worktree add`, runs `git rev-parse --verify --quiet refs/heads/<branch>` in `sourceRepo`. Exit 1 fails with `WorktreeReattachError { cause: 'Branch <branch> no longer exists' }`; any other non-zero exit fails with cause `git rev-parse exited with code <n>`. The `GitOps` JSDoc in `src/host/services/worktrees-seam.ts` states it.

### RPC — `PROTOCOL_VERSION` 0.0.23 → 0.0.24

`UnarchiveTab { paneId }`, a query with `error: WorktreeNotRestoredError`. The handler maps `TabNotFoundError` to success with a log, as `ArchiveTab` does. The `DiaRpcs` JSDoc (`rpc.ts:119`) lists `UnarchiveTab` among the queries.

### Preload and renderer

- `DiaApi.unarchiveTab(paneId): Promise<string | null>` in `src/shared/ipc/contract.ts`, with JSDoc: the failure reason or `null`, as `archiveTab`. Implemented in `src/preload/host-api.ts`.
- `actions.unarchiveTab(paneId)` in `src/renderer/src/lib/actions.ts`, exported through `src/renderer/src/plugin-api.ts`'s `actions`.
- A toast: `pnpm dlx shadcn@latest add toast` adds `src/renderer/src/components/ui/toast.tsx` (base-nova registry item; Base UI Toast; [ui.shadcn.com/docs/components/base/toast](https://ui.shadcn.com/docs/components/base/toast)). It exports `toast`, a manager from `Toast.createToastManager()`, and `Toaster`. `<Toaster />` is mounted beside `TooltipProvider` in `src/renderer/src/main.tsx`, and `plugin-api.ts` adds `export * from './components/ui/toast'`, as for the other `ui` primitives. This work runs the `impeccable` and `shadcn` skills (`src/renderer/CLAUDE.md`).
- `plugins/agent-overview/agent-row.tsx`: an archived row's menu gains **Unarchive**, which calls `actions.unarchiveTab` and, for a returned reason, calls `toast.add({ title: 'Could not unarchive <name>', description: reason, type: 'error' })`.
- `plugins/agent-overview/retire-agent-dialog.tsx`: the worktree path line shows only for a tab that is not archived, because an archived tab's worktree is already gone.
- `plugins/chat/archived-transcript.tsx`: the empty caption reads `This agent is archived. Its transcript is empty.` and the JSDoc says the transcript comes from the agent's stored conversation.

### Docs

- `docs/designs/archive-delete-agents.md`: the "Restore (unarchive)" row, the `Tab` JSDoc line ("never run"), the `archiveTab` line that says it removes `config.worktree`, the `WorkspaceStore.save` line that deletes the `agent_worktrees` row of an archived tab, the archived transcript caption, and the "Not changed" Remove Project line are updated and point to this spec.
- `docs/adr/0051-session-event-store-in-host-db.md`: the "Archive and unarchive" bullet and the "Bad, because `host.db` grows" consequence name superseded streaming `MessageUpdated` and `ReasoningUpdated` events, marked "(amended by #158)".

## Tests

All run under vitest without `claude` installed. `pane-workspace.test.ts`'s `makeHarness` gains an `AgentEventStore` fake (`Layer.succeed`) whose `append` records the agent id and event tags in `harness.log` and can be made to fail; "no event written" asserts `log` has no `append` entry.

| Test | File |
| --- | --- |
| Appending `AgentArchived` deletes superseded streaming message and reasoning events, keeps a trailing unsuperseded streaming event, keeps `ToolCallStarted`, and leaves `readHistory` unchanged | `agent-event-store.test.ts` |
| `unarchiveTab` restores a worktree tab via `reattachWorktree`, appends `AgentUnarchived`, and marks it not archived | `pane-workspace.test.ts` |
| A failing `reattachWorktree`, or a missing `cwd`, fails with `WorktreeNotRestoredError`, writes no event, and leaves the tab archived | `pane-workspace.test.ts` |
| Unarchive of a tab that is not archived succeeds, runs no git call and appends no event | `pane-workspace.test.ts` |
| `archiveTab` appends `AgentArchived` and keeps `config.worktree`; `unarchiveTab` clears `archived` | `pane-workspace.test.ts`, `src/shared/domain/workspace.test.ts` |
| `removalItemsOf` lists no `WorktreeItem` for an archived tab | `src/shared/domain/project-removal.test.ts` (new file) |
| `UnarchiveTab`'s `paneId` reaches the handler unchanged | `src/host/ipc/rpc-handlers.test.ts`; `src/host/ipc/host-server.test.ts` adds `UnarchiveTab: unused` to its `DiaRpcs.toLayer` stub |
| With the fake spawner: `rev-parse` exit 1 fails with `Branch <branch> no longer exists` and runs no `worktree add`; exit 128 fails with `git rev-parse exited with code 128`; exit 0 proceeds to the add. The existing "non-zero exit" test returns 0 for `rev-parse` and 128 for `worktree add`, so it still tests the add failure | `plugins/worktrees/git-ops.test.ts` |

## Not changed

Delete. Remove Project (apart from `removalItemsOf`). `GetPaneChat` and `PaneChatProjection`. The Host plugin API (`@dia/plugin`). `tab-header.tsx` keeps showing the `WorktreeChip` for an archived tab; it names the kept branch.

## Refinement Record

Runner: subagent (sonnet). Effort: medium.

| Round | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | Correlated `EXISTS` on `item_id` rescans the agent's rows per row; only `(agent_id, sequence)` is indexed | major | Applied: one window-function `DELETE` |
| 1 | Compaction of `ReasoningUpdated` widens ADR-0051's archive bullet without saying so | major | Applied: Reason column says so; ADR bullets amended in Docs |
| 1 | `markRetiring` does not check `archived`, so unarchive of a live tab would run git | blocker | Applied: explicit not-archived check inside the guarded block |
| 1 | `rev-parse` exit 128 (bad repo) would read as "branch no longer exists"; branch checked out elsewhere stays generic | major | Applied: exit 1 only; other codes reported; the checked-out case recorded as not handled |
| 1 | `project.ts` Tab JSDoc, `workspace.ts` JSDoc and `archive-delete-agents.md` line 46 still say archive drops the worktree | major | Applied: listed under Interface and Docs |
| 1 | A new toast duplicates the agent-overview `notice` banner (Minimize Complexity) | major | Rejected: the user chose the toast in the Understand phase. Registry item verified with `shadcn view @shadcn/toast` (base-nova `toast.tsx` exports `toast` and `Toaster`); skill triggers added |
| 1 | `WorktreeReattachError.cause` is `unknown`, not a string | minor | Applied |
| 1 | Behaviour of a visible tab after unarchive was unverified | minor | Applied: verified that the first `SendMessage` calls `ensureLive` (`rpc-handlers.ts:119`) |
| 1 | No test plan | minor | Applied: Tests section |
| 1 | `contract.ts` and the `rpc.ts` JSDoc not named | minor | Applied |
| 1 | Unarchive offered on pre-change worktree agents always fails | minor | Applied: stated in the decision row |
| 1 | `WorktreeNotRestoredError.path` holds `cwd` for a tab with no worktree | minor | Applied: JSDoc says so |
| 2 | `git-ops.test.ts` uses a fake spawner, not a real repo; existing add-failure test would now fail at `rev-parse` | major | Applied: test row rewritten for the fake spawner |
| 2 | `pane-workspace.test.ts` harness provides no `AgentEventStore` | major | Applied: harness fake recording `append` calls; JSDoc of `makePaneWorkspaceLive` lists it |
| 2 | `project` returns one statement per case | minor | Applied: `Effect.andThen` of the update and the DELETE |
| 2 | More stale lines in `archive-delete-agents.md` | minor | Applied |
| 2 | `<Toaster />` mount file not named | minor | Applied: `src/renderer/src/main.tsx` |
| 2 | RPC test file not named | minor | Applied |
| 3 | `host-server.test.ts` enumerates every RPC, so it must gain `UnarchiveTab` | major | Applied |
| 3 | `project-removal.test.ts` does not exist | minor | Applied: marked new file |
| 3 | `TabNotFoundError` for an existing, non-archived tab misnames the case | minor | Applied: a no-op success |
| 3 | Drop `path` from `WorktreeNotRestoredError` | minor | Rejected: matches `WorktreeNotRemovedError { paneId, path, reason }`, and the path goes into the Host log |
| 3 | Extract a `withRetiring` helper shared with `retireTab` | minor | Rejected: the shared protocol is two calls (`markRetiring`, `ensuring(clearRetiring)`); refactoring `retireTab` is outside the change |
| 3 | Raise the toast inside `actions.unarchiveTab` | minor | Rejected: keeps `actions.unarchiveTab` shaped like `archiveTab` and `deleteTab`, which return the reason; one caller |
| 3 | Build the SQL tag list from schema constants | minor | Rejected: the store already writes `event_type` as the literal `_tag` and matches it as literals (`'AgentArchived'` cases) |
| 3 | Non-empty unregistered path has no specific reason | minor | Rejected: `reattachWorktree` checks it before `git worktree add` and fails with `path exists, is not a registered worktree, and is not empty` (`git-ops.ts:257-262`) |
