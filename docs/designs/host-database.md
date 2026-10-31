# Host database (issue #71)

Scope: layer. Spans `src/shared/plugin` (plugin context), `src/host/services` (kernel database), `src/host/plugins/host-plugins.ts` (plugin context wiring), `src/host/host-main.ts` (layer wiring), `package.json`, every shipped `plugin.json`, and ADR-0042.

## Name and Purpose

Gives the Host kernel and each plugin that asks for one a SQLite database of its own, opened with its owner's migrations applied, so Host runtime state that must survive a restart has one storage technology with one crash and migration behaviour.

## Modules

| Module | Location | Owns |
| --- | --- | --- |
| `openDatabase`, `makeHostDatabaseLive` | `src/host/services/database.ts` | opening a SQLite file by building `SqliteClient.layer` (which provides `Reactivity`) in the caller's scope, checking and applying a migration record, closing the file when that scope closes; `<userData>/host.db` with the kernel migrations from `kernel-migrations.ts` (the first, `1_workspace`, is #94's; `docs/designs/workspace-store.md`) |
| Plugin database | `src/shared/plugin/api.ts` (`HostPluginContext.database`, `MigrationKey`, `PluginMigrations`, `PluginDatabaseError`), `src/host/plugins/host-plugins.ts` (`extend`) | `<dataDir>/data.db`, opened in the plugin's setup scope. `MigrationKey` (compile-time shape) and the key check in `openDatabase` (runtime) state one format, `<id>_<name>`; change both together |
| Plugin API version | `src/shared/plugin/manifest.ts`, every `plugins/*/plugin.json` | `0.0.5` → `0.0.6` |
| Docs | JSDoc of `HostPluginContext` (`api.ts`) and `makeHostPluginsLive` (`host-plugins.ts`) | list `database` next to `dataDir`. No repo doc lists the context members, so no other doc changes |
| ADR-0042 | `docs/adr/0042-sqlite-for-host-runtime-state.md`, `docs/adr/README.md` | the technology, the file-per-owner rule, the storage-shape rule, the consumer table, the verdict on each JSON file |

## Interface

### Plugin context (`src/shared/plugin/api.ts`)

```ts
import type { SqlClient } from 'effect/sql'

/** A migration key: `<id>_<name>`, for example `1_create_turns`. `id` is a non-negative integer, unique within one owner's migrations. */
export type MigrationKey = `${number}_${string}`

/**
 * A plugin's migrations, keyed by {@link MigrationKey}. Pending migrations run once, in id order,
 * in a single transaction: if one fails, none of that run's migrations apply. A migration whose id is not above the highest id already applied never runs, so
 * add a new migration with an id above every shipped one, and never edit or renumber a shipped one.
 */
export type PluginMigrations = Readonly<Record<MigrationKey, Effect.Effect<void, unknown, SqlClient.SqlClient>>>

/** Failure of `ctx.database`: `filename` could not be opened, a migration key is malformed or duplicated, or a migration failed. `message` states which. */
export class PluginDatabaseError extends Data.TaggedError('PluginDatabaseError')<{
  readonly filename: string
  readonly message: string
}> {}

export interface HostPluginContext extends PluginServices {
  readonly events: Stream.Stream<EventFrame>
  readonly dataDir: string
  readonly activities: PluginActivities
  /**
   * Opens this plugin's SQLite database, `<dataDir>/data.db`, applies `migrations`, and returns a
   * client for it. The connection closes when the scope it runs in (the plugin's setup scope)
   * closes. The file is created on the first call and kept across reloads, overrides and restarts.
   * Call it at most once per setup; a second call in the same setup is a defect, even when the
   * first call failed.
   */
  readonly database: (
    migrations: PluginMigrations
  ) => Effect.Effect<SqlClient.SqlClient, PluginDatabaseError, Scope.Scope>
}
```

`effect/sql` is part of `effect` and imports no Node, DOM or Electron module, so `src/shared` stays platform-neutral (ADR-0013). A plugin imports `SqlClient` from `effect/sql` (the `SqlClient` namespace; the service type is `SqlClient.SqlClient`), the same way it imports `effect` today; `@dia/plugin` gains no export. Because `SqlClient` is now part of the plugin contract, a change in the `SqlClient` surface that plugins use bumps `PLUGIN_API_VERSION`.

### Kernel database (`src/host/services/database.ts`)

```ts
/** Failure of {@link openDatabase} when a migration key does not match `<id>_<name>` or two keys share an id. Carries the file and the offending key. */
export class InvalidMigrationKeyError extends Data.TaggedError('InvalidMigrationKeyError')<{
  readonly filename: string
  readonly key: string
}> {
  override get message() {
    return `Migration key "${this.key}" in ${this.filename} is not <id>_<name>, or its id repeats`
  }
}

/**
 * Opens the SQLite file at `filename` with write-ahead journaling and a busy timeout, applies
 * `migrations`, and returns a client. The connection closes when the surrounding scope closes.
 * Checks every key before opening the file. Fails with InvalidMigrationKeyError for a malformed
 * or duplicate key, SqlError when the file cannot be opened, and MigrationError when a migration fails.
 */
export const openDatabase: (
  filename: string,
  migrations: Readonly<Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>>
) => Effect.Effect<SqlClient.SqlClient, InvalidMigrationKeyError | SqlError | MigrationError, Scope.Scope>

/**
 * Provides `SqlClient` for `<userDataPath>/host.db` with the kernel migrations applied. A Host
 * service that keeps runtime state across a restart requires `SqlClient` from this layer.
 * Building it fails, and the Host does not start, when the file cannot be opened or a migration fails.
 */
export const makeHostDatabaseLive: (
  userDataPath: string
) => Layer.Layer<SqlClient.SqlClient, InvalidMigrationKeyError | SqlError | MigrationError>
```

- `openDatabase` checks keys itself because `SqliteMigrator.fromRecord` drops a key that does not match `/^(\d+)_(.+)$/` without an error (`effect/src/sql/Migrator.ts:420-432`), and `MigrationKey` does not reject every bad key at compile time (`1.5_x` type-checks).
- It builds the client with `Layer.buildWithScope(SqliteClient.layer({ filename }), connection)`, where `connection` is a child of the caller's scope that `openDatabase` closes when opening or a migration fails, so a failed open never leaves the file locked; it takes `SqlClient` from the built context then runs `SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })` against it. WAL and the busy timeout are the `SqliteClient` defaults; `openDatabase` passes no option for them.
- `host-main.ts` adds `makeHostDatabaseLive(init.userDataPath)` to `state`, so the database opens at Host start and closes at Host shutdown.

### Plugin wiring (`src/host/services/database.ts`, `src/host/plugins/host-plugins.ts`)

```ts
/** Builds the `database` member of a plugin's context for `filename`, owned by plugin `plugin`. */
export const makePluginDatabase: (filename: string, plugin: string) =>
  (migrations: PluginMigrations) => Effect.Effect<SqlClient.SqlClient, PluginDatabaseError, Scope.Scope>
```

It holds the `opened` flag, dies with `${plugin} called ctx.database twice in one setup` on a second call, maps every failure to `PluginDatabaseError { filename, message }`, and annotates logs with `plugin`. `extend` adds `database: makePluginDatabase(path.join(dataDir, 'data.db'), services.name)` to the object it returns through `Effect.as`. `extend` runs once per open (`plugin-registry.ts:379`), so the flag is per setup. The effect runs inside the plugin's setup scope (`plugin-registry.ts:387-389`), so the connection closes when that scope closes. A failure the plugin does not handle fails its setup, and the plugin follows the setup-failure path (`Failed`, or `Loaded.reloadError` on reload).

### Logging

`openDatabase` logs `Opened database` with `filename` and the ids of the migrations it applied (`Effect.logInfo`); a failure is logged with `Effect.logError` and `filename` before it fails. The plugin wiring wraps the `database` effect in `Effect.annotateLogs({ plugin: services.name })`, so `openDatabase`'s logs carry the plugin name.

## Key Data Structures

- On disk: one SQLite file per owner. `host.db` belongs to the kernel; `plugins/<name>/data.db` belongs to plugin `<name>`. Each file holds its own `effect_sql_migrations` table, written by `SqliteMigrator`.

## Storage-shape rule (recorded in ADR-0042, applied by each consumer)

| What the consumer reads | Shape | Example |
| --- | --- | --- |
| Only the current value; a write replaces it | Relational table, upsert | #69 parked state per pane |
| An ordered list whose items are removed when used | Relational table with a position column | #69 held message queue |
| Facts that never change once written, read as history | Append-only table: `INSERT` only; `DELETE` only for retention | #72 turn index, #42 citations |
| Current state *and* its history | Event table + projection table, both written in one `sql.withTransaction`; reads use the projection; the event table can rebuild the projection | #40 task and objective transitions, the ADR-0034 decision path |

Current state is never derived by replaying events at Host start.

## Design Rationale

**One file per owner** — a plugin's tables, migrations and lifetime belong to the plugin, so its database opens and closes with its scope, a reload does not touch another owner's tables, and a migration numbering conflict between owners cannot occur. Plugins share data through services (`ctx.provide`/`ctx.inject`), not tables (Information Hiding).

**A context member, not a package import** — the kernel decides the file path, journaling, the busy timeout and when the connection closes; a plugin states only its migrations. A plugin that opened `SqliteClient` itself could pick another path or leave a connection open after its scope closed.

**Migrations are the only argument** — opening without migrations has no use, and passing them at open means a plugin can never read a table before it exists (Define Errors Out of Existence). Keys are checked before the file opens, so a mistyped key fails the load instead of skipping a table (Fail Fast).

**A second call is a defect** — memoising the first client would ignore the second call's migrations. `PluginActivities.register` already treats a repeated id as a defect (`api.ts:78-80`).

**No event-log helper** — `sql.withTransaction` writes an event and its projection atomically; a helper would be shaped by a consumer that does not exist yet (Strategic Programming). The first consumer that needs one adds it.

**Host start fails on a broken `host.db`** — continuing without the database would drop state a later service depends on (for example a parked agent's resume time) without telling the user.

## Rejected Alternatives

**One shared `dia.db` with prefixed tables** — rejected by the user: migrations from every owner share one table and one numbering, and a plugin reload could not close its connection.

**Expose the plugin's `SqlClient` through `ctx.provide` keys** — rejected: a database is not a service another plugin should inject.

**Open the plugin database eagerly for every plugin** — rejected: every plugin would get a file it does not use.

## Tests

- `database.test.ts` (temp directory): `openDatabase` applies migrations once (a second open applies none and keeps the rows); `PRAGMA journal_mode` is `wal`; after its scope closes, `host.db` can be deleted and the temp directory removed recursively, and no `-wal` or `-shm` file remains (Windows refuses to delete an open file); with pending `1_a` and a failing `2_b`, opening fails with `MigrationError` and neither table exists; a key `create_turns` and the pair `1_a`/`01_b` fail with `InvalidMigrationKeyError` and create no file.
- `database.test.ts`, `makePluginDatabase`: a bad key and a failing migration map to `PluginDatabaseError` (the bad key's message names it); a second call dies naming the plugin, including after a failed first call; no file exists until the plugin calls it; a call returns a client on the file with its migrations applied. These run against `makePluginDatabase` directly because vitest cannot load a TypeScript plugin `host` entry through `makeHostPluginsLive` (`plugin-modules.test.ts` uses a child process for that).
- Shipped manifests load on `0.0.6` (existing fixtures use `PLUGIN_API_VERSION`).

## Refinement Record

**Round 1**

Applied
- *Correctness / Fail Fast* — `fromRecord` drops a non-matching key silently and skips ids at or below the latest applied (`Migrator.ts:271`, `420-432`): added `MigrationKey`, the key check in `openDatabase`, `InvalidMigrationKeyError`, the id rule in `PluginMigrations` JSDoc, and tests.
- *Correctness* — `SqliteClient.make` requires `Reactivity`: `openDatabase` now builds `SqliteClient.layer` with `Layer.build`.
- *Correctness* — where the "second call" flag lives: added the plugin wiring section.
- *Project rules (JSDoc)* — `HostPluginContext` and `makeHostPluginsLive` JSDoc and the plugin-authoring skill list `database`: added the Docs row.
- *Correctness* — how `ctx.database` maps errors was unspecified: added the plugin wiring section with the `PluginDatabaseError` mapping.
- *Consistency* — `PluginDatabaseError` gained `filename`, like the sibling errors' structured fields.
- *Minimize Complexity* — removed the separate kernel-migrations module.
- *Correctness* — the "5 second" busy timeout is a library default, not set by dia: wording changed.
- *Tests* — added the defect, bad-key and error-mapping tests.
- *Contract* — stated that a `SqlClient` change plugins use bumps `PLUGIN_API_VERSION`.

Rejected
- *Tests* — a child-process test that a plugin resolves `effect/sql` at runtime: plugins already resolve `effect` from the repo's `node_modules` (`plugins/worktrees/host.ts`), and `effect/sql` is a subpath export of the same package (`effect/package.json:53`).

**Round 2**

Applied
- *Correctness* — all pending migrations share one transaction (`Migrator.ts:331`): `PluginMigrations` JSDoc and the failing-migration test now say so.
- *Correctness* — the wiring snippet used undefined `filename` and `messageOf`: rewritten inside the `Effect.as` literal.
- *Correctness* — `effect/sql` exports a `SqlClient` namespace (`sql/index.ts:18`): import and prose aligned.
- *Tests* — WAL leaves `-wal`/`-shm` files while open: the close tests check that none remain and remove the directory.
- *Single source of truth* — the key format appears as a type and as a regex: the Modules row says to change both together.

Rejected
- *Correctness* — "`@effect/sql-sqlite-node` wraps `better-sqlite3`, a native addon": the packed 4.0.6 dist imports only `node:sqlite` and `effect/*`, and its package declares no dependencies (`npm view @effect/sql-sqlite-node@4.0.6 dependencies` is empty). No `asarUnpack` or rebuild is needed. ADR-0042 still states that it supersedes ADR-0008's native-module objection to SQLite, and **Verify** opens `host.db` in the running app.

**Round 3** (no blocker or major; rounds stop)

Applied
- *Correctness* — `InvalidMigrationKeyError` had no `message` in its snippet: added the getter and a test.
- *Correctness* — `SqlClient` is a namespace: every type position now reads `SqlClient.SqlClient`.
- *Project rules (logging)* — the plugin name is added with `Effect.annotateLogs`.
- *Tests* — the second-call defect test asserts the message and the after-failure case.

Checked and kept
- `let opened` in `extend`: the repo uses plain `let` inside Effect code (`pane-workspace.ts:305`); the check and set are synchronous.
- `import type { SqlClient } from 'effect/sql'` in `src/shared`: no Node import in `effect/src/sql`; `biome.json` restricts only `@effect/platform-node`. `pnpm typecheck` confirms at implementation.

**Implementation**

- *Correctness* — the failing-migration test showed `openDatabase` left the connection open in the caller's scope after a failure (Windows reported `EBUSY` on `test.db-wal`). `openDatabase` now opens in a child scope and closes it on failure.
- *Testability* — the plugin-side behaviour moved into `makePluginDatabase` so it can be tested without loading a plugin entry.
