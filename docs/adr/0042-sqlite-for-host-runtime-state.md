---
status: "accepted"
date: 2026-10-31
decision-makers: William Pei
---

# Store Host runtime state in SQLite, one database file per owner

## Context and Problem Statement

Several features need Host state that survives an app restart: parked agents (#69), the diff viewer's turn index (#72), the org's roles, objectives and tasks (#40), task memory (#42) and routines (#45). The Host persists to JSON files in the profile (`workspace.json`, `activity.json`, `settings.json`) and plugins keep files in `HostPluginContext.dataDir` (ADR-0032). Transcripts belong to the Agent SDK session store (ADR-0011). If each feature chooses its own storage, dia ends up with several formats with different crash and migration behaviour. Which storage technology holds Host runtime state, and how do Host services and plugins reach it?

## Decision Drivers

* A write must survive dia crashing or being killed mid-write.
* Several Host services and plugins write state in the same Host process.
* Schemas change across dia versions, and dia updates itself (ADR-0016).
* The installer must not gain native modules or binaries to unpack (ADR-0016, ADR-0037).
* A plugin's state must load, reload and close with the plugin (ADR-0019, ADR-0026).

## Considered Options

* SQLite through Electron's built-in `node:sqlite`, with `@effect/sql-sqlite-node`
* SQLite through `better-sqlite3`
* PGlite (Postgres compiled to WASM) through `@effect/sql-pglite`
* An embedded Postgres server (`embedded-postgres`)
* Extend the JSON files in the profile

## Decision Outcome

Chosen option: "SQLite through Electron's built-in `node:sqlite`, with `@effect/sql-sqlite-node`", because it is the only option with transactional writes, a migration runner and no packaging cost. Electron 45 ships Node 24.22.0 with SQLite 3.53.4, and `node:sqlite` opened a database in WAL mode inside an Electron `utilityProcess` (the Host's process type, ADR-0021). `@effect/sql-sqlite-node` 4.0.6 imports only `node:sqlite` and `effect`, and provides `SqlClient` and `SqliteMigrator`.

### Access

| Owner | File | Opened by |
| --- | --- | --- |
| Host kernel | `<userData>/host.db` | `makeHostDatabaseLive` (`src/host/services/database.ts`) at Host start. A Host service requires `SqlClient` from it. A file that cannot be opened, or a migration that fails, stops the Host from starting |
| Plugin `<name>` | `<userData>/plugins/<name>/data.db` | `ctx.database(migrations)` in the plugin's setup. The connection closes when the setup scope closes. A plugin that never calls it gets no file |

* Each file has its own migrations, keyed `<id>_<name>`. Pending migrations run in one transaction. A malformed or duplicate key fails the open before the file is created.
* Plugins share data through services (`ctx.provide`, `ctx.inject`), never through each other's tables.
* `SqlClient` from `effect/sql` is now part of the plugin contract. The plugin API moved to `0.0.6`; a change in the `SqlClient` surface that plugins use bumps it again.

### Storage shape

Each consumer chooses a shape by what it reads:

| What the consumer reads | Shape |
| --- | --- |
| Only the current value; a write replaces it | Relational table, written by upsert |
| An ordered list whose items are removed when used | Relational table with a position column |
| Facts that never change once written, read as history | Append-only table: `INSERT` only; `DELETE` only for retention |
| Current state and its history | An event table and a projection table, both written in one `sql.withTransaction`. Reads use the projection; the event table can rebuild it |

Current state is never derived by replaying events at Host start, so startup time does not grow with history.

### Consumers

| Issue | State | Store | Shape |
| --- | --- | --- | --- |
| #69 | Parked cause, `resetsAt`, resume mode per pane | `host.db` | Relational, upsert |
| #69 | Held message queue per pane (owned by the claude-code adapter, `plugins/claude-code/message-queue.ts`) | claude-code adapter's `data.db` | Relational, position column |
| #69 | Each tab's last activity line (today `activity.json`) | `host.db` | Relational, upsert |
| #72 | Turn index: turn → start and end tree ids; tool call → hunks | diff viewer plugin's `data.db` | Append-only |
| #40 | Roles, hired agents, org settings | org plugin's `data.db` | Relational |
| #40 | Objectives and tasks, their state transitions, the decision path (ADR-0034) | org plugin's `data.db` | Events + projection |
| #42 | Task ↔ session links (the transcript stays in the SDK store, ADR-0011) | org plugin's `data.db` | Append-only |
| #42 | Scratchpad per task | org plugin's `data.db` | Relational |
| #42 | Long-term memory entries, with FTS5 search | org plugin's `data.db` | Relational |
| #42 | Citations: entry, time, task | org plugin's `data.db` | Append-only; counts and staleness are queries |
| #45 | Routines | routines plugin's `data.db` | Relational |

This answers the `docs/prds/org.md` open question for #42: long-term memory is stored in SQLite, not the meta repo.

### Existing JSON files

| File | Writer | Verdict |
| --- | --- | --- |
| `workspace.json` | `PersistenceService` only; the whole project and tab tree, written atomically | Stays JSON |
| `activity.json` | `AgentSummaries`; one line per pane, rewritten whole | Moves to `host.db` with #69, next to the rest of the pane runtime state |
| `settings.json` | `SettingsStore`; read-modify-write per setter | Stays JSON. It is written in place (`settings-store.ts`), not through a temp file and rename, so a crash mid-write can truncate it; #87 makes the write atomic |
| `plugins/claude-code/install.json` | claude-code adapter; one path | Stays JSON |
| `plugins/claude-code/models.json` | claude-code adapter; a cache rewritten whole once a day | Stays JSON |

### Consequences

* Good, because a write is a SQLite transaction: in WAL mode it survives dia being killed after the commit returns. Measured: 50 committed rows survived `SIGKILL` of the `utilityProcess`. Electron's SQLite opens with `PRAGMA synchronous = 2` (`FULL`) and `@effect/sql-sqlite-node` does not change it; with WAL, `FULL` also keeps a committed transaction through a power loss ([sqlite.org/pragma.html](https://www.sqlite.org/pragma.html#pragma_synchronous)).
* Good, because the installer is unchanged: no native module, no `asarUnpack` entry, no binary.
* Good, because a plugin's tables, migrations and connection belong to the plugin, so a reload or an override never touches another owner's data.
* Good, because FTS5 and the JSON functions work in Electron's SQLite build, which #42's memory search needs.
* Bad, because `node:sqlite` is a release candidate (stability 1.2) in Node 24, not stable, and Electron 37.2.0 shipped without it once (electron/electron#47671). An Electron upgrade must check that `node:sqlite` still loads in a `utilityProcess`.
* Bad, because `node:sqlite` runs synchronously on the Host's event loop. A slow query blocks every pane's events until it returns.
* Bad, because a migration commits before the rest of the plugin's setup runs. If a reload's setup then fails, the registry reopens the previous version (ADR-0026) against the migrated schema, which that version may not read. A plugin keeps its migrations additive (new tables and nullable columns) so an older version still works.
* Bad, because one file per owner rules out a SQL join across owners; a feature that needs data from two plugins asks one of them through a service.
* Bad, because `synchronous = FULL` flushes to disk on each commit: 200 single-row commits took 372 ms (about 1.9 ms each). A consumer that writes many rows at once wraps them in one transaction.

## Pros and Cons of the Options

### SQLite through `better-sqlite3`

* Good, because it is a mature SQLite binding.
* Bad, because it is a native module: it needs a rebuild for Electron's ABI and an `asarUnpack` entry (its troubleshooting guide).

### PGlite through `@effect/sql-pglite`

* Good, because it is Postgres, with `jsonb`, Postgres full-text search and extensions such as pgvector.
* Bad, because opening it added 1.5 s on the first start and 134 ms on later starts, and 244–506 MB to the process's memory, measured in an Electron 45 `utilityProcess`. One instance per plugin is not affordable.
* Bad, because it accepts one connection, so every owner would share one instance.
* Bad, because a PGlite minor-version upgrade may need a `pg_dump` and restore (its upgrade guide), which dia's auto-update would have to run.
* Bad, because its documentation makes no statement about durability across a crash.

### An embedded Postgres server

* Good, because it is a full Postgres.
* Bad, because it runs a separate server process, and its Windows binaries are about 104 MB.

### Extend the JSON files

* Good, because it needs no dependency.
* Bad, because each feature writes its own versioning and migration code, rewrites a whole file per change, and has no transaction across two files.

## More Information

* Design: `docs/designs/host-database.md`.
* Extends ADR-0032 (the plugin context gains `database` next to `dataDir`).
* ADR-0008 rejected SQLite because of native-module packaging; `node:sqlite` removes that objection. ADR-0008 is already superseded by ADR-0011.
* Related: #40, #42, #45, #69, #72.
