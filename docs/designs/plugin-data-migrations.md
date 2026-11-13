# Plugin data migrations and `dia-` plugin names

Status: accepted. Issue #239, step 1 of `docs/plans/2026-11-13-foundation.md`. ADRs: ADR-0077, ADR-0078 (amended by this design, see Decisions).

## Name and Purpose

A plugin moves its data folder by declaring a data migration in `plugin.json`; the Host moves the folder before the plugin loads and records a `PathsMoved` entry, and every owner of path references rewrites its own references. The first use renames every first-party plugin to `dia-<name>`.

## Scope

In scope:

* Manifest `dataMigrations`; the Host runs them in the plugin loader, before the registry prepares the plugin context.
* `PathMoves`, a kernel service over `host.db`: which migrations ran, the `PathsMoved` log, and owner acknowledgements.
* Path owners: the kernel workspace (`PaneWorkspace`), `dia-worktrees`, `dia-claude-code`. `ctx.onPathsMoved` on the Host plugin context; `PLUGIN_API_VERSION` 0.0.36 → 0.0.37 and every shipped `plugin.json` `api`.
* `before` steps for `dia-worktrees` and `dia-meta` that stop `git fsmonitor--daemon` in the folder.
* Renaming every plugin under `plugins/` to `dia-<name>`: folder, `plugin.json` `name`, every `@dia-plugin/<name>` import, every string naming a plugin, and the `settings.json` keys of `pluginOverrides` and `adapters`.

Out of scope: rewriting `Project.directory` (no project is expected inside a plugin data folder); rewriting `pluginOverrides` values (source paths the user chose); Claude Code's per-project entries in `~/.claude.json`; renderer-only plugins (`extend`, which creates a data folder, runs only for plugins with a host entry, `plugin-registry.ts:796-809`, so they have no data folder to move).

Checked at design time: no `host.db` column stores a plugin name. The tables are those in `kernel-migrations.ts`; `agents.model` holds a model id (`PaneConfig.model`), and no kernel source under `src/host` names `claude-code` as a string. This settles the open item in ADR-0077's More Information.

## Hand tests

Recorded in `docs/reasoning/2026-11-13-plugin-data-move-hand-tests.md`.

1. Claude Code resumes a session after its working directory and its folder under `~/.claude/projects/` are both renamed to the new cwd's encoding: `claude -p --resume <id>` from the new directory answered from the earlier turn. ADR-0078's claim holds.
2. `git worktree repair <new paths>` run in the main repository restores both links of worktrees moved together with their parent folder on Windows; `git worktree list` shows the new paths without `prunable`. ADR-0078's claim holds.
3. Found during test 2: with `core.fsmonitor=true` (set globally on the user's machine), git starts a `git fsmonitor--daemon` per worktree that holds a handle on it, and renaming any ancestor folder fails with `EPERM` (from `mv`, PowerShell and Node `fs.renameSync`). `git fsmonitor--daemon stop` in each worktree lets the rename succeed.

## Success criteria

| # | Criterion | Observed in |
| --- | --- | --- |
| 1 | Every folder under `plugins/` starts with `dia-`, and each `plugin.json` `name` equals its folder name | test over `plugins/*` |
| 2 | After first start each `<userData>/plugins/<old>` is at `<userData>/plugins/dia-<old>` | data-migrations test; app |
| 3 | A start with both `<userData>/plugins/<old>` and `<userData>/plugins/dia-<old>` fails that plugin's load with an error naming both paths; neither folder changes | data-migrations test; app |
| 4 | A migration that ran does not run again; when `from` is gone and the data folder exists, the `PathsMoved` entry is recorded (crash after the rename) | data-migrations test |
| 5 | A rename that fails fails the plugin's load with an error naming `from`, the data folder and the cause; nothing is recorded, so the next load retries | data-migrations test |
| 6 | An owner registered after an entry was recorded receives it at registration; one registered before receives it when recorded; an acknowledged entry is not delivered again; a failed delivery is retried at the next registration or record | path-moves test |
| 7 | A tab whose `cwd` or `worktree.path` lies under a moved folder has the new path in memory and in `host.db` | WorkspaceOps test; app |
| 8 | `dia-worktrees` rewrites its ledger paths, and `git worktree list` in the source repo shows the new path | ledger test; app |
| 9 | `dia-claude-code` renames the transcript folder of each moved cwd; the moved worktree tab's conversation resumes | transcript-folders test; app |
| 10 | `pluginOverrides` and `adapters` keys named after an old first-party plugin are renamed `dia-<name>`; when `dia-<name>` already exists the old key stays | settings-store test |
| 11 | Issues (`dia-issues`) and MCP servers (`dia-mcp`) show their existing data | app |

## Modules

### Manifest (`src/shared/plugin/manifest.ts`)

```ts
/** A folder under the user data folder, as `/`-separated lowercase segments; no `..`, no absolute path. */
export const UserDataPath = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/))

/** One data migration: `id` is `<n>_<name>`; `from` is the folder it moves; `before` a plugin module. */
export const DataMigration = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^\d+_[a-z0-9_]+$/)),
  from: UserDataPath,
  before: Schema.optional(PluginExport)
})
// PluginManifest gains: dataMigrations: Schema.optional(Schema.Array(DataMigration))
```

`before` is a `.ts` path relative to the plugin directory (the shape `PluginExport` already checks). Its default export is `(move: PathsMoved) => Effect<void, unknown>` and runs before the rename. A `before` failure is logged and the rename is still tried; if the rename then fails, the error message includes the `before` failure.

### `PathsMoved` and `relocatePath` (`src/shared/plugin/paths-moved.ts`, exported from `@dia/plugin`)

`PathsMoved = Schema.Struct({ from: Schema.String, to: Schema.String })`, both absolute. `relocatePath(path, move): Option<string>` returns `to` plus the rest of `path` when `path` equals `from` or continues it with `\` or `/`; the comparison ignores case when `from` contains `\` (Windows). Otherwise none.

### `PathMoves` (`src/host/services/path-moves.ts`)

Owns the data-migration log, the `PathsMoved` log and acknowledgements. Kernel migration `5_path_moves` creates `data_migrations (plugin, migration_id, ran_at, PRIMARY KEY (plugin, migration_id))`, `paths_moved (sequence INTEGER PRIMARY KEY AUTOINCREMENT, from_path, to_path, moved_at)`, `path_move_acks (owner, sequence, PRIMARY KEY (owner, sequence))`.

```ts
class PathMoves extends Context.Service<PathMoves, {
  readonly hasRun: (plugin: string, id: string) => Effect<boolean, PathMovesError>
  /** Marks the migration run; nothing moved. */
  readonly recordRun: (plugin: string, id: string) => Effect<void, PathMovesError>
  /** Marks the migration run and records `move`, in one transaction, then delivers it to every subscriber. */
  readonly recordMove: (plugin: string, id: string, move: PathsMoved) => Effect<void, PathMovesError>
  /** Subscribes `owner` for the life of the scope and delivers every entry it has not acknowledged. */
  readonly subscribe: (owner: string, apply: (move: PathsMoved) => Effect<void, unknown>) => Effect<void, never, Scope>
}>
```

Delivery runs entries in `sequence` order, under one semaphore for all owners. A successful `apply` inserts the acknowledgement; a failure is logged and stops that owner's delivery until its next `subscribe` or the next `recordMove`. `apply` must not call `subscribe` or `recordMove`. `PathMovesLive` requires the `host.db` `SqlClient`; `buildHostLayer` provides it to `HostPlugins` and `PaneWorkspace`.

### Data migration runner (`src/host/plugins/data-migrations.ts`)

`makeDataMigrations(userDataPath)` returns `migrate(manifest, root)`, which the Host plugin loader runs inside `load`'s module transaction before the registry's `use` (so before `extend` creates the data folder, `plugin-registry.ts:809`). For each migration not yet run, with `to = <userData>/plugins/<manifest.name>`:

| `from` exists | `to` exists | Action |
| --- | --- | --- |
| yes | no | run `before`, rename `from` to `to`; on success `recordMove`; on failure `PluginLoadError` naming `from`, `to` and the cause |
| yes | yes | `PluginLoadError` naming both paths |
| no | yes | `recordMove` (the rename ran before a crash, or a migration was added after the folder existed; owners then do a no-op scan) |
| no | no | `recordRun` |

### Plugin context: `ctx.onPathsMoved(apply)`

`HostPluginContext.onPathsMoved: (apply: (move: PathsMoved) => Effect<void, unknown>) => Effect<void, never, Scope>` subscribes the plugin under its name.

### Kernel owner: `PaneWorkspace`

`WorkspaceOps.movePaths(workspace, move)` (pure) rewrites each tab's `config.cwd` and `config.worktree.path` through `relocatePath` and returns the same object when nothing changed. `PaneWorkspaceLive` subscribes owner `workspace` and applies it through `mutate`, so memory, `host.db` and `WorkspaceChanged` change together.

### `dia-worktrees`

* `before` (`data-migration.ts`): `git fsmonitor--daemon stop` in each directory under `<from>/trees`; each failure is ignored (no daemon running).
* owner: `ledger.movePaths(move)` rewrites the `path` of each ledger row under `from` and returns the moved entries; for those whose directory exists, `git worktree repair <paths>` runs once per source repo.

### `dia-meta`

* `before` (`data-migration.ts`): `git fsmonitor--daemon stop` in `<from>/repo`.

### `dia-claude-code`

Owner `transcriptFolders.move(move)`: lists sessions with the SDK's `listSessions()` (every project), takes the distinct `cwd`s that `relocatePath` moves, and renames `transcriptFolderOf(cwd)` to `transcriptFolderOf(newCwd)`. `transcriptFolderOf(cwd)` is `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd with each character outside [A-Za-z0-9] replaced by ->`. A missing source folder is skipped; an existing destination is logged and skipped (no merge, no delete). A cwd whose encoding exceeds 200 characters is logged and skipped, because Claude Code shortens such names (unverified; worktree paths are about 80 characters). The plugin subscribes before it provides the agent backend.

### Settings (`src/host/services/settings-store.ts`)

At layer build, `renamePluginKeys` renames each `pluginOverrides` and `adapters` key in the list of first-party names at 2026-11-13 (ADR-0077) to `dia-<name>` when `dia-<name>` is absent, and writes the file once when anything changed. `PluginSources` reads overrides after the layer is built.

## Ordering

`PaneWorkspaceLive` is built with the host layer (`host-main.ts:260`) before `HostPlugins.start()` (`host-main.ts:272`), so it is subscribed before any migration runs. `dia-worktrees` and `dia-meta` are `eager`, so their moves finish before `HostReady` and no tab resumes with an old path. `dia-claude-code` and `dia-worktrees` receive an entry when it is recorded if they are loaded, or at their `onPathsMoved` call in setup.

## Decisions taken without the user

1. Migrations are data in `plugin.json` with an optional `before` module; ADR-0078's `after` effect is dropped. Alternatives: one module per migration exporting `{ id, from, after }` (every renamed plugin would need a module to state two strings); a named export of the host entry (the Host would import the entry before knowing it can load). `after` is unneeded because a plugin receives its own move as a path owner, which also covers a crash after the rename; `before` exists for hand test 3. ADR-0078 is amended in place (accepted the same day, not yet implemented) rather than superseded.
2. Settings keys are renamed from a fixed list. Alternative: derive renames from manifests; `PluginSources` reads overrides before any manifest is read, so that needs a second pass over the catalog.
3. `pluginOverrides` values are not rewritten; an override whose folder still has the old manifest name fails with the existing name-mismatch error.
4. A transcript folder whose destination exists is skipped, not merged.
5. The `no`/`yes` migration row records a move even when no crash happened; the cost is one owner scan.

## Refinement Record

**Round 1 (subagent, sonnet)**

* Applied: B1 undefined `RelativeDataPath` → `UserDataPath`; `before` imported with `modules.importEntry`. B2 rename failure row added (criterion 5). M4 reasoning entry indexed in `docs/REASONING.md`. M5 host.db plugin-name check done and recorded. M6 case-insensitive Windows match in `relocatePath`. M7 long-path skip marked unverified. M8 both `before` plugins are `eager` (checked `plugin.json`). M9 accepted cost recorded (decision 5). M10 `apply` constraints stated. M11 layer wiring and `api` bump stated. m12 `onPathsMoved`, `subscribe`, `relocatePath`. m13 `recordRun`/`recordMove` split. m14 `transcriptFolderOf`. m16 `before` failure in the rename error.
* Rejected: B3 (raise the ADR conflict with the user first): the user is unavailable and directed decisions be taken and recorded; the issue asks for the ADR to be updated with the hand-test results. Recorded as decision 1. m15 (removal plan for the fixed list): dia has no release cadence to tie it to. m17 (`DataMigrations` service): the loader receives one `migrate` function, not the seven fields.

**Round 2 (inline)**

* No blocker or major finding. Checked: `migrate` receives `manifest.name`, so the catalog name and data folder agree; `recordMove` delivery to `workspace` happens inside the plugin load, before `HostReady`.
