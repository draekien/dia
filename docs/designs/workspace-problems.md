# Workspace problems

Scope: layer. Issue #97, the last step of #10's stack, stacked on #132.

Governing decisions: ADR-0043 (workspace in `host.db`), ADR-0046 (dia keeps the harness's transcripts). Store design: `docs/designs/workspace-store.md`. Visual rules: `DESIGN.md` (Workspace Problems).

## Success criteria

1. A `host.db` agent row that `WorkspaceStore.load` leaves out (for example `thinking_level = 'ultra'`) is listed with its name and the decode reason.
2. Delete on that row, after a confirmation that names what is removed, deletes its `agents` row and the rows that cascade from it. Delete on a left-out project row deletes it and its agents.
3. Keep for later hides the row until dia restarts; the row stays in `host.db`, and the list shows it again after a restart.
4. A tab in `workspace.imported.json` that the import skipped because it shares a session id or worktree path with an earlier tab is listed, naming the value it shares and the agent that holds it.
5. Import without its session adds the tab, with no session, to the project of its directory. Import without its worktree adds it with no worktree. Discard drops it from the list.
6. A conflict that was imported or discarded is not listed again, also after a restart.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| How Keep for later is remembered | Not stored. The renderer hides the row for the rest of the run; the Host lists every left-out row on each call | The issue says "stays stored, retried on each start" and the Done-when says the list shows it again after a restart. A stored "kept" flag would hide it after a restart |
| How an imported or discarded conflict is remembered | A `host.db` table `import_resolutions`, keyed by the skipped tab's pane id (kernel migration `2_import_resolutions`) | `workspace.imported.json` stays the user's untouched record of the original file; the pane id is the only tab value both file versions keep across reads (a version 1 read generates project ids and names afresh) |
| Which values an import drops | Every value of the tab that `host.db` holds at the time of the action: its session id when any `agent_sessions` row has it, its worktree when any `agent_worktrees` row has its path | A value the file shared may since have been freed (the earlier tab was deleted) or taken by another agent. Checking `host.db`, including left-out rows, keeps `save` from failing on `PRIMARY KEY (session_id)` or `UNIQUE (path)`, a failure `PaneWorkspace` only logs |
| Action labels | `Import without its session`, `Import without its worktree`, `Import without its session and worktree`, or `Import` when nothing is held any more; all send one `import` resolution | One host rule, and the label states exactly what the rule drops |
| Working directory of a tab imported without its worktree | Unchanged | The session's transcript is stored under its working directory, so changing `cwd` would make the session unresumable. The tab works in the holder's worktree directory while it exists |
| Project of an imported tab | The registered project with the file project's directory key; when none, the file's project is registered with the tab | Matches how the import grouped tabs. The visible tab does not change, as in `registerProject` |
| What Delete removes | The row and its cascade: for an agent its worktree and session records; for a project its agents. No worktree directory or transcript on disk | The worktree may belong to another dia version's agent; ADR-0046 keeps transcripts. The dialog says what stays |
| Deleting a row `load` returned | Refused (a no-op, logged) | Delete is only for rows the user cannot see; a loaded row is changed through `PaneWorkspace` |
| Discard confirmation | None | Discard deletes nothing: the file keeps the tab |
| Where the UI lives | A kernel component `WorkspaceProblemsBanner`, exported from `@dia/renderer-plugin` and placed by the layout plugin under `AccountBanner`; a Dialog lists the problems | Same placement and pattern as `AccountBanner` |
| Colour | Neutral strip, caption muted text, no amber | `PRODUCT.md`: attention signals are reserved for agent state; `AccountBanner` precedent |
| Live updates | The renderer reads the list on mount and after each action | The list changes only through these actions or a project removal (whose cascade only shrinks it; a stale row's Delete is a no-op) |
| `PROTOCOL_VERSION` | 0.0.18 to 0.0.19 | `DiaRpcs` gains three RPCs |
| `PLUGIN_API_VERSION` | Not bumped | Only `@dia/renderer-plugin` gains an export; precedent (#14, #118) adds renderer exports without a bump |

## Interface

### Shared domain — `src/shared/domain/workspace-problem.ts`

```ts
/** A stored project `load` left out, with the decode reason and how many stored agents it holds. */
export const UnreadableProject = Schema.TaggedStruct('UnreadableProject', {
  projectId: Schema.String, name: Schema.String, agents: Schema.Finite, reason: Schema.String
})
/** A stored agent of a loaded project that `load` left out, with the decode reason. */
export const UnreadableAgent = Schema.TaggedStruct('UnreadableAgent', {
  agentId: Schema.String, name: Schema.String, project: Schema.String, reason: Schema.String
})
/** A value of a skipped import tab that a stored agent holds. */
export const HeldValue = Schema.Struct({ value: Schema.String, heldBy: Schema.String })
/** A tab of `workspace.imported.json` the import skipped; `session`/`worktree` are present while held. */
export const ImportConflict = Schema.TaggedStruct('ImportConflict', {
  agentId: Schema.String, name: Schema.String, project: Schema.String,
  session: Schema.optional(HeldValue), worktree: Schema.optional(HeldValue)
})
export const WorkspaceProblem = Schema.Union([UnreadableProject, UnreadableAgent, ImportConflict])
/** What the user decided for an import conflict. */
export const ImportResolution = Schema.Literals(['import', 'discard'])
/** Which stored row to delete. */
export const UnreadableRow = Schema.Struct({ kind: Schema.Literals(['project', 'agent']), id: Schema.String })
/** A problem could not be listed or resolved; carries the reason to show. */
export class WorkspaceProblemError extends Schema.TaggedError<WorkspaceProblemError>()(
  'WorkspaceProblemError', { reason: Schema.String }) {}
```

### `WorkspaceStore` (`workspace-store.ts`) gains

```ts
/** Every stored project and agent `load` leaves out, with the decode reason. An agent of a left-out project is counted in its project. */
readonly unreadable: Effect.Effect<ReadonlyArray<UnreadableProject | UnreadableAgent>, WorkspaceLoadError>
/** Deletes a stored row `load` left out, and the rows that cascade from it. A row `load` returned, or a missing row, is left alone. */
readonly deleteUnreadable: (row: UnreadableRow) => Effect.Effect<void, WorkspaceWriteError>
/** The name of the stored agent holding each session id and worktree path, including agents `load` left out. */
readonly holders: Effect.Effect<Holders, WorkspaceLoadError>
```

### `readSkippedImportTabs` (`workspace-import.ts`)

`(userDataPath) => Effect<ReadonlyArray<{ project: Project; tab: Tab }>, never, FileSystem | Path | Crypto>` — the tabs of `workspace.imported.json` that `readLegacyWorkspace` leaves out, with their project. A missing, unreadable or malformed file gives none, logged.

### `PaneWorkspace.importTab` (`pane-workspace.ts`)

`(project: Project, tab: Tab) => Effect<void, ProjectNotFoundError>` — adds a tab that has not started to the registered project with `project`'s directory key, registering `project` with it when none has it. The visible tab does not change; a tab with the same pane id leaves the workspace unchanged. Fails when that project is being removed.

### `WorkspaceProblems` (`workspace-problems.ts`, new)

```ts
export class WorkspaceProblems extends Context.Service<WorkspaceProblems, {
  /** Every problem: unreadable stored rows, then import conflicts not yet resolved and not in the workspace. */
  readonly list: Effect.Effect<ReadonlyArray<WorkspaceProblem>, WorkspaceProblemError>
  /** Deletes an unreadable stored row; see WorkspaceStore.deleteUnreadable. */
  readonly deleteUnreadable: (row: UnreadableRow) => Effect.Effect<void, WorkspaceProblemError>
  /** Imports (dropping every held value) or discards the skipped tab `agentId`, and records it so it is never listed again. An unknown or resolved id is a no-op. */
  readonly resolveImportConflict: (agentId: string, resolution: ImportResolution) => Effect.Effect<void, WorkspaceProblemError>
}>()('WorkspaceProblems') {}
export const makeWorkspaceProblemsLive: (userDataPath: string) => Layer<WorkspaceProblems, never, WorkspaceStore | PaneWorkspace | SqlClient | FileSystem | Path | Crypto>
```

### RPCs (`rpc.ts`) and `window.dia.workspaceProblems`

| RPC | Payload | Success | Error |
| --- | --- | --- | --- |
| `ListWorkspaceProblems` | none | `Array<WorkspaceProblem>` | `WorkspaceProblemError` |
| `DeleteUnreadableRow` | `UnreadableRow` | void | `WorkspaceProblemError` |
| `ResolveImportConflict` | `{ agentId, resolution }` | void | `WorkspaceProblemError` |

`window.dia.workspaceProblems`: `list(): Promise<ReadonlyArray<WorkspaceProblem>>` (empty on an error, logged), `deleteRow(row): Promise<string | null>` and `resolveImportConflict(agentId, resolution): Promise<string | null>` (null when done, else the reason), as `deleteTab` does.

## Key data structures

```sql
CREATE TABLE import_resolutions (
  agent_id    TEXT    PRIMARY KEY,
  resolution  TEXT    NOT NULL CHECK (resolution IN ('imported', 'discarded')),
  resolved_at INTEGER NOT NULL
)
```

No foreign key: a discarded tab has no `agents` row, and an imported tab deleted later must stay resolved.

## UI

- **Strip:** under `AccountBanner`, same shape (one line, caption, muted, `border-b`): `2 workspace items need a decision` and a ghost `Review` button. Hidden when the list, minus rows kept for later, is empty.
- **Dialog** `Workspace problems`: up to two groups, `Could not be loaded` (stored rows) and `Skipped when importing` (conflicts). Each row: the name in medium weight with its project in caption; the reason underneath (decode reason in mono, a conflict as `Shares session 9c37a1b2… with brave-otter`, the id or path in mono); actions right-aligned. Stored row: ghost `Keep for later`, destructive-outline `Delete…`. Conflict: outline import button with the label from Decisions, ghost `Discard`. A failed action shows its reason in error red under the row. The dialog closes when the list empties.
- **Delete confirmation:** AlertDialog `Delete agent brave-otter?` / `Delete project acme?`. Body: what dia removes from its own records (the agent, its worktree record and its session history; for a project also its N agents), that the worktree directory and Claude Code transcripts stay on disk, and that it cannot be undone. Destructive `Delete`, then `Try again` after a failure.

## Verification

Tests: `workspace-store.test.ts` (unreadable lists the agent and the project with its agent count; delete removes the row and cascades; a loaded id is refused; holders), `workspace-import.test.ts` or the store test (skipped tabs from both file versions), `workspace-problems.test.ts` (conflict labels follow held values; import adds a tab without the held session; discard and import are not listed again across a new layer over the same database), `pane-workspace.test.ts` (`importTab` into an existing and a missing project, visible tab unchanged), `rpc-handlers.test.ts` (payload fields reach the service), renderer `workspace-problems-banner.test.tsx` (strip count, Keep for later hides, Delete confirms).

App (verify-in-app, packaged build): criteria 1–6 with a scratch profile.

## Refinement record

Runner inline (no subagents allowed in this run), effort medium.

Round 1:
- *major, correctness* — "strip the shared values recorded in the file": a value freed or taken since the import makes the action wrong or makes `save` fail silently. Applied: drop values `host.db` holds at action time (Decisions).
- *major, correctness* — changing `cwd` when dropping a worktree breaks resume. Applied: `cwd` unchanged.
- *major, Define Errors Out of Existence* — `deleteUnreadable` could delete a loaded row. Applied: refused for ids the store loaded or saved.
- *minor, Strategic Programming* — separate `importWithoutSession`/`importWithoutWorktree` RPCs mirror button labels. Applied: one `import` resolution.
- *minor* — fold `sessionIds` into `holders`. Rejected: out of scope, `sessionIds` callers unchanged.

Round 2: no blocker or major finding.
