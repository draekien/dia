# Workspace store

Issue: #94. Decision: ADR-0043 (supersedes ADR-0042's "`workspace.json` stays JSON" row). Scope: module.

## Name and Purpose

`WorkspaceStore` keeps the Host's `Workspace` (every project, its tabs, their order and the visible tab) in `<userData>/host.db`, records every SDK session each tab has had, and imports a `workspace.json` left by an earlier version once.

## Interface

```ts
// src/host/services/workspace-store.ts

/** Service tag for the Host's persisted workspace. Provide it with {@link makeWorkspaceStoreLive}. */
export class WorkspaceStore extends Context.Service<WorkspaceStore, {
  /**
   * The saved workspace, or `None` when no workspace has been saved. Reads only. A stored project
   * or agent that does not decode is left out and logged, and stays stored untouched (#97 lists
   * them for the user). Fails with `WorkspaceLoadError` only when `host.db` cannot be read.
   */
  readonly load: Effect.Effect<Option.Option<Workspace>, WorkspaceLoadError>
  /**
   * Makes the stored workspace equal `workspace`, in one transaction. Unchanged projects and tabs
   * keep their rows, and a row is deleted only when its project or tab is gone from `workspace`,
   * so rows in other tables that reference an agent survive. Rows that `load` left out are never
   * deleted or changed, except by the cascade when their project is removed. A tab whose `sessionId` changed keeps
   * its previous session as a superseded session. Fails with `WorkspaceWriteError`; nothing is
   * applied then.
   */
  readonly save: (workspace: Workspace) => Effect.Effect<void, WorkspaceWriteError>
}>()('WorkspaceStore') {}

/**
 * Builds the live WorkspaceStore over `host.db`. When the database holds no workspace, building it
 * imports the `workspace.json` an earlier version of dia left in `userDataPath` and keeps the
 * original file as `workspace.imported.json`; a missing, unreadable or malformed file is logged
 * and left in place, and the store starts empty. A tab whose session id or worktree path an earlier
 * tab in the file already holds is not imported and is logged; the original file keeps it. Building
 * fails with `WorkspaceLoadError` only when `host.db` cannot be read or written. Requires `SqlClient` (from `makeHostDatabaseLive`),
 * `FileSystem`, `Path` and `Crypto`.
 */
export const makeWorkspaceStoreLive: (userDataPath: string) =>
  Layer.Layer<WorkspaceStore, WorkspaceLoadError, SqlClient.SqlClient | FileSystem.FileSystem | Path.Path | Crypto.Crypto>

/** `host.db` could not be read, or an imported workspace could not be written to it. Carries the `SqlError`. */
export class WorkspaceLoadError extends Data.TaggedError('WorkspaceLoadError')<{ readonly cause: unknown }> {}

/** `save` could not write the workspace; nothing was applied. Carries the cause (a `SqlError`). */
export class WorkspaceWriteError extends Data.TaggedError('WorkspaceWriteError')<{ readonly cause: unknown }> {}
```

Deliverables: `docs/adr/0043-*.md` with its `docs/adr/README.md` entry and ADR-0042 marked amended by it; `kernel-migrations.ts`, `workspace-store.ts`, `workspace-import.ts`, `workspace-store.test.ts`; the caller changes below.

Callers:

| Caller | Before | After |
| --- | --- | --- |
| `makePaneWorkspaceLive` (`pane-workspace.ts`) | `persistence.loadWorkspace`, `persistence.saveWorkspace` | `store.load`, `store.save`; its JSDoc requires `WorkspaceStore` instead of `PersistenceService`. A `WorkspaceLoadError` (an unreadable `host.db`) fails the layer, as a failed `host.db` open does today |
| `PersistenceService` (`persistence.ts`) | workspace and activity | activity only (`saveActivity`, `loadActivity`) until #69 moves it. `PersistedWorkspace` moves to `workspace-import.ts`, its JSDoc naming the file reader; `migrate`, the `workspace.v1.json` copy and the workspace JSDoc are deleted from `persistence.ts` |
| `host-main.ts` | `persistence` layer feeds `workspace`; `makeHostDatabaseLive` only in `state` | one `const hostDatabase = makeHostDatabaseLive(init.userDataPath)`, provided to the store as `Layer.provide(makeWorkspaceStoreLive(...), Layer.merge(hostDatabase, NodeServices.layer))` and merged into `state` (one layer value, so one connection); the store feeds `workspace`; `persistence` still feeds `summaries` |
| `agent-summaries.test.ts`, `pane-workspace.test.ts` | fake `PersistenceService` with workspace methods | `agent-summaries.test.ts` drops `loadWorkspace`/`saveWorkspace` from its fake; `pane-workspace.test.ts` fakes `WorkspaceStore`. The workspace cases of `persistence.test.ts` move to `workspace-store.test.ts` |
| `openDatabase` (`database.ts`) | WAL, busy timeout, migrations | also runs `PRAGMA foreign_keys = ON` before the migrations |

`PROTOCOL_VERSION` is unchanged: no RPC or event shape changes.

## Key Data Structures

Kernel migration `1_workspace` in `src/host/services/kernel-migrations.ts` (moved out of `database.ts`, as `docs/designs/host-database.md` planned). It runs one statement per `sql.unsafe` call:

```sql
CREATE TABLE projects (
  project_id    TEXT    PRIMARY KEY,
  position      INTEGER NOT NULL,
  directory     TEXT    NOT NULL,
  directory_key TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  is_git_repo   INTEGER NOT NULL CHECK (is_git_repo IN (0, 1))
);

CREATE TABLE agents (
  agent_id        TEXT    PRIMARY KEY,            -- Tab.config.paneId
  project_id      TEXT    NOT NULL REFERENCES projects ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  archived        INTEGER NOT NULL CHECK (archived IN (0, 1)),
  cwd             TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  thinking_level  TEXT    NOT NULL,
  permission_mode TEXT    NOT NULL
);

CREATE TABLE agent_worktrees (
  agent_id    TEXT PRIMARY KEY REFERENCES agents ON DELETE CASCADE,
  path        TEXT NOT NULL UNIQUE,
  branch      TEXT NOT NULL,
  source_repo TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  session_id    TEXT    PRIMARY KEY,
  agent_id      TEXT    NOT NULL REFERENCES agents ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,                 -- epoch ms from Clock.currentTimeMillis
  superseded_at INTEGER                           -- NULL: the tab's current session
);
CREATE UNIQUE INDEX agent_sessions_one_current ON agent_sessions (agent_id) WHERE superseded_at IS NULL;

CREATE TABLE workspace_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  visible_agent TEXT REFERENCES agents ON DELETE SET NULL
);
```

Mapping to the domain (`src/shared/domain/project.ts`, `pane.ts`); the domain types are unchanged:

| Domain | Row |
| --- | --- |
| `Workspace.projects[i].project` | `projects` row, `position = i` |
| `ProjectEntry.tabs[j]` | `agents` row, `position = j` within its project |
| `Tab.config.worktree` | `agent_worktrees` row, absent when `undefined` |
| `Tab.sessionId` | that agent's `agent_sessions` row with `superseded_at IS NULL`; none when `undefined` |
| `Workspace.visibleTab` | `workspace_state.visible_agent` |
| (no domain field) | superseded `agent_sessions` rows; for #14 and #96, never loaded into `Workspace` |

`workspace_state` has its row once any workspace was saved, including an empty one. "`host.db` holds no workspace" means that row is absent.

## Internal Decomposition

- **`workspace-store.ts`** — the service; owns the SQL.
  - `load` decodes each project row with `Project`, and each agent row together with its worktree and current session with `Tab` (`is_git_repo` and `archived` 0/1 to boolean; an absent worktree or session is omitted, never `null`), ordered by `position`. A row that fails is left out and logged with its decode issue; an agent of a left-out project is left out too. `visible_agent` becomes `visibleTab` when it names a loaded, unarchived tab, otherwise `null`. The `Workspace` is built from the decoded parts without decoding it again: its remaining checks (duplicate directory, duplicate pane id) are guaranteed by `UNIQUE` and `PRIMARY KEY`, and the visible tab by the rule above.
  - The store keeps, in a `Ref`, the project and agent ids it has loaded or saved. Those are the only ids `save` may delete.
  - `save` first fails with `WorkspaceWriteError` when two tabs in `workspace` share a `sessionId` or a worktree `path`; `Workspace` checks neither.
  - `save` binds booleans as 0/1 and optional values as `null`, never `undefined`, which `node:sqlite` rejects. It runs in one `sql.withTransaction`:
    1. Read the stored worktree agent ids and the current session per agent.
    2. For each known project id (the `Ref`) absent from `workspace`, `DELETE FROM projects WHERE project_id = ?`; for each known agent id absent, `DELETE FROM agents WHERE agent_id = ?`. Cascades remove the rest. Rows `load` left out are not known, so they stay. After commit the `Ref` holds the ids in `workspace`.
    3. Upsert every project, then every agent (`agents.project_id` is checked per statement), with `INSERT … ON CONFLICT (…) DO UPDATE SET …` listing every column, never `INSERT OR REPLACE`, which deletes the row and cascades.
    4. Delete the worktree rows of agents that now have none, then upsert each present worktree, so a path that moves between tabs in one save does not violate `UNIQUE (path)`.
    5. Pass one: for each agent whose stored current session differs from `Tab.sessionId`, `UPDATE agent_sessions SET superseded_at = <now> WHERE agent_id = ? AND superseded_at IS NULL`. Pass two: for each such agent with `Tab.sessionId` set, `INSERT INTO agent_sessions (session_id, agent_id, started_at, superseded_at) VALUES (?, ?, <now>, NULL) ON CONFLICT (session_id) DO UPDATE SET superseded_at = NULL WHERE agent_id = excluded.agent_id RETURNING session_id`; no returned row means the id belongs to another agent, and `save` fails with `WorkspaceWriteError`. `<now>` is `Clock.currentTimeMillis`.
    6. Upsert `workspace_state`.
  - Every `SqlError` from `load`, `save` and the construction-time import is mapped into `WorkspaceLoadError` or `WorkspaceWriteError`, keeping the cause.
  - Logs `save` (debug, with the counts of deleted and superseded rows) and `load` (info).
- **`workspace-import.ts`** — knows the `workspace.json` formats; moved out of `persistence.ts`. Exports `readLegacyWorkspace(userDataPath): Effect<Option<Workspace>, never, FileSystem | Path | Crypto>` (version 2, or version 1 through the existing `workspace-migration.ts`; a missing, unreadable or malformed file is logged and yields `None`; a tab whose session id or worktree path an earlier tab holds is dropped and logged with its name) and `markImported(userDataPath): Effect<void, never, FileSystem>` (renames the file to `workspace.imported.json`; a failure is logged). Neither fails.
- **`kernel-migrations.ts`** — the `host.db` migration record, starting with `1_workspace`.

## Verification

`workspace-store.test.ts`, against a temporary `host.db` (issue #94's criteria):

1. A fresh database with no `workspace.json` gives `load = None`; saving a project with a tab writes one `projects` and one `agents` row.
2. A version 2 `workspace.json` imports the same projects, tabs, order, configs, worktrees, session ids and visible tab, and is renamed to `workspace.imported.json`.
3. A version 1 `workspace.json` is migrated, then imported.
4. A malformed or unreadable `workspace.json` stays in place, and the store starts empty.
5. Changing a tab's `sessionId` leaves two `agent_sessions` rows, one with `superseded_at` set.
6. Clearing a tab's `sessionId` leaves the old row superseded and no current row.
7. A row in a test table that references `agents` survives a `save` that keeps its agent.
8. Removing a project deletes its `projects`, `agents`, `agent_worktrees` and `agent_sessions` rows (cascade, so the pragma holds).
9. Every `Tab` and `PaneConfig` field, and project and tab order after a reorder, survive `save` then `load`.
10. A worktree path that moves between tabs in one save succeeds.
11. An import with two tabs sharing a worktree path, and one with two tabs sharing a session id, import the first tab only, and the file is renamed.
12. An agent row with an unknown `thinking_level` is left out of `load`, and survives a later `save` unchanged; removing its project deletes it.

Restart behaviour, `/clear` and project removal in the running app go to **Verify**.

## Design Rationale

**A new `WorkspaceStore` instead of extending `PersistenceService`** — the workspace and the activity lines are separate knowledge: one lives in `host.db`, the other in `activity.json` until #69. One service for both would depend on `SqlClient` and the file system for unrelated reasons. `PersistenceService` keeps activity until #69 retires it.

**`load` and `save` keep whole-workspace semantics** — `PaneWorkspace` holds the whole `Workspace` in a `Ref` and saves it after every `mutate`. Keeping a whole-workspace `save` means no `PaneWorkspace` operation changes, and `PaneWorkspace` does not learn that the storage is relational (Information Hiding).

**Diff save instead of delete-and-reinsert** — #69's tables will reference `agents (agent_id)` with `ON DELETE CASCADE`. Rewriting every row would delete their rows on every save.

**Session history is derived from `Tab.sessionId` changes** — every session id reaches the workspace through `recordSessionId` (`pane-workspace.ts`), including `/clear`'s `new_conversation_id` and a rewind's fork. Comparing the stored current session to `Tab.sessionId` at save time records each change without a new domain field. The two passes in step 5 keep the partial unique index satisfied. A session never moves between tabs, so an id already held by another agent is an error, not a move. A session first stored by the import gets `started_at` = import time; its real start was never recorded.

**`PRAGMA foreign_keys = ON` in `openDatabase`** — `node:sqlite` enables foreign keys by default (`enableForeignKeyConstraints`, default `true`; `PRAGMA foreign_keys` returns `1` on Node 24.21), but `@effect/sql-sqlite-node` 4.0.6 does not pass the option, so the behaviour would rest on a driver default (checked on Node 24.21 in development; Electron's Node not checked). The pragma states it. `openDatabase` runs it on the client's single connection before `SqliteMigrator.run`, because the migrator runs in a transaction, where the pragma is a no-op. Plugin databases opened through `openDatabase` get it too. A test asserts that removing a project cascades.

**`position` has no `UNIQUE` constraint** — a reorder upserts rows one at a time, and swapping two positions would violate `UNIQUE` within the transaction. The `Workspace` arrays define the order; `save` writes `position` as the array index, and `load` orders by it.

**The import runs when the layer is built, not in `load`** — `load` stays a query (Command-Query Separation). Only the store knows whether `host.db` holds a workspace, so the store's construction imports, as `makeHostDatabaseLive` applies migrations when built. The import runs only while `workspace_state` has no row. The file is renamed after `save` commits; a rename failure is logged and ignored, and the file is not read again because the row now exists, so a crash between commit and rename leaves `workspace.json` in place, unread. A failed import `save` fails the layer with `WorkspaceLoadError`: the Host does not start and the file is untouched. The version 1 `workspace.v1.json` copy is dropped: `workspace.imported.json` keeps the original file, of either version. A tab that shares a worktree `path` or session id with an earlier tab in the file (possible only in a hand-edited or version 1 file; `Workspace` checks neither) is dropped from the import and logged, so the import never fails on it; `workspace.imported.json` keeps it, and #97 offers the user to import it without the shared value or discard it.

**`load` leaves out rows that do not decode, and `save` never deletes them** — a Host that fails to start is restarted every second by `host-process.ts` while the window shows the startup skeleton, so failing gives the user no way to recover. Returning `None` instead would make the next `save` delete every row. Loading what decodes, and limiting deletes to ids the store loaded or saved, keeps every unread row stored unchanged, so a later dia version can read it again, and #97 can list it with Keep and Delete actions. A `SqlError` on reading `host.db` still fails the layer, as a failed open does today; that is outside this change.

**No `CHECK` on `thinking_level`, `permission_mode`** — SQLite cannot alter a `CHECK`, so a new level would need a table rebuild. Decoding through `PaneConfig` on `load` rejects unknown values.

## Rejected Alternatives

**One JSON row holding the encoded `Workspace`** — rejected in #94: other tables could not reference an agent.

**`earlierSessionIds` on `Tab`** — rejected in #94: only #14 and #96 need earlier sessions, and both read them from `host.db`.

**Row-level writes from each `PaneWorkspace` operation** — more precise writes, but every operation in `WorkspaceOps` would need a SQL twin, and `PaneWorkspace` would learn the storage layout.

**`UNIQUE` on `position`** — see Design Rationale. This schema supersedes the SQL sketch in #94.

**`loadOrImport`, a `load` that may write** — rejected in round 1 for importing at layer construction, which keeps `load` a query.

## Refinement Record

**Round 1 — Applied**
- *Correctness* — the import's crash behaviour contradicted the `workspace_state` rule; rewritten: a file not renamed after commit stays unread, a failed import save fails the layer.
- *Correctness* — step 5 superseded by a snapshot id and its upsert did not move `agent_id`; now two passes and `DO UPDATE SET agent_id = excluded.agent_id, superseded_at = NULL`.
- *Correctness* — `load`'s row-to-`Workspace` mapping was unstated; stated, with null/undefined and boolean binding.
- *Correctness* — `host-main.ts` wiring would open `host.db` twice; one `hostDatabase` layer value shared.
- *Correctness / project rule* — dropping the pragma departed from #94's decision; the pragma is kept.
- *Consistency* — dropped `UNIQUE (position)` and renamed index recorded against #94's sketch.
- *Minor* — step 2 deletes by the ids read in step 1 instead of `NOT IN` lists.
- *Project rule (JSDoc, logging, Clock)* — JSDoc on every export; logging and `Clock.currentTimeMillis` stated.
- *Information Hiding* — `load` JSDoc no longer names `migrateLegacyWorkspace`.
- *Fail Fast* — recovery path for an undecodable `host.db` stated.
- *Literal wording* — "rejected by the user" → "rejected in #94".

**Round 2 — Applied**
- *Fail Fast* — a legacy file with a duplicate worktree path or session id fails the import save; recovery and a test stated.
- *Correctness* — `SqlError` was outside the declared error types; mapped into the two errors.
- *Correctness* — step 3 order (projects before agents) and full `DO UPDATE SET` stated.
- *Correctness* — step 4 now deletes before it upserts, for `UNIQUE (path)`.
- *Correctness* — why the pragma runs before the migrator stated; Node version claim qualified.
- *Information Hiding / JSDoc* — `workspace-import.ts` exports named.
- *Callers* — test fakes and the store's `host-main.ts` provision listed.

**Round 3 — Applied**
- *Correctness* — step 5 moved a session shared by two tabs between them on every save; `save` now rejects a shared session id or worktree path, and the upsert only revives a session of the same agent.
- *Verification* — each #94 criterion mapped to a test.
- *Names as Documentation* — `PersistedWorkspace`, `migrate` and the v1 copy accounted for.
- *Project rule* — deliverables (ADR-0043, index) listed; migration runs one statement per call.

**Gate — user corrections**
- *Recoverability* — the Host no longer fails on undecodable rows or import conflicts: unread rows are kept and never deleted, conflicting import tabs are skipped and logged. The in-app list with resolve actions is #97.

**Round 3 — Rejected**
- *Naming* — `WorkspaceUnavailableError` for the import failure. Rejected: the `WorkspaceLoadError` JSDoc already covers "saved", and a second error type adds no handling.

**Round 1 — Rejected**
- *Command-Query Separation* — proposed renaming `load` to `loadOrImport`. Rejected for a fix that removes the violation: the import moved to layer construction, so `load` only reads.
