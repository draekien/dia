# SQLite in the Host: `node:sqlite`, silent migration keys, and locked files

**Date:** 2026-10-31

## Context

Choosing the storage for Host runtime state (#71, ADR-0042) and building `openDatabase` (`src/host/services/database.ts`).

## Reasoning / Learning

* **`node:sqlite` loads in the Host.** No Electron document states that `node:sqlite` is enabled. A probe forked with `utilityProcess.fork` in Electron 45.0.0 reported `process.type` `utility`, Node 24.22.0, SQLite 3.53.4, and `journal_mode` `wal`. Electron 37.2.0 once shipped without it ("No such binding: sqlite", electron/electron#47671). `node:sqlite` is stability 1.2 (release candidate) in Node 24.
* **Electron's SQLite opens with `PRAGMA synchronous = 2` (`FULL`).** `@effect/sql-sqlite-node` 4.0.6 does not change it. Each commit flushes to disk: 200 single-row commits took 372 ms.
* **`@effect/sql-sqlite-node` 4.0.6 is not a native module.** Its `dist` imports only `node:sqlite` and `effect/*`, and it declares no dependencies, so the installer needs no `asarUnpack` entry for it.
* **`SqliteMigrator.fromRecord` drops a key that does not match `/^(\d+)_(.+)$/` without an error** (`effect/src/sql/Migrator.ts`, `fromRecord`). `create_turns` runs nothing. Ids are compared as numbers, so `1_a` and `01_b` collide, and a migration whose id is at or below the highest applied id never runs. `openDatabase` therefore checks every key before it opens the file.
* **`Migrator.run` wraps all pending migrations in one transaction**, so with pending `1_a` and a failing `2_b`, neither table is created.
* **A failed open leaves the file locked on Windows** if the connection is built in the caller's scope: the caller's scope stays open, and deleting the directory fails with `EBUSY` on `<file>-wal`. `openDatabase` builds the connection in a child scope and closes that scope on failure.
* **PGlite was measured and rejected.** In an Electron 45 `utilityProcess`, PGlite 0.5.13 took 1475 ms to open on first start and 134 ms after, and added 244–506 MB of RSS.

## Implication

* Before upgrading Electron, check that `require('node:sqlite')` still works in a `utilityProcess`.
* Write migration keys as `<id>_<name>` with ids above every shipped id; the key check fails the open otherwise.
* A test that opens a database must close its scope on failure too, or Windows cannot remove the temp directory.
