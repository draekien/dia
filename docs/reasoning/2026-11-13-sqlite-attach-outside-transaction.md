# Copying from another SQLite file: `ATTACH` must run outside the transaction

**Date:** 2026-11-13

## Context

The `dia-run-events` plugin copies the legacy event log from `host.db` into its own `data.db` once (#241). The first idea was to run the copy as a plugin migration.

## Reasoning / Learning

SQLite refuses `ATTACH` and `DETACH` inside a transaction (`cannot ATTACH database within transaction`). The migrator runs all pending migrations in one transaction, so a migration cannot attach `host.db`. The copy in `plugins/dia-run-events/handover.ts` therefore runs after the migrations: `ATTACH`, then one `sql.withTransaction` that copies the rows and inserts the `handover` row, then `DETACH` in `Effect.ensuring`.

This works because `@effect/sql-sqlite-node`'s `SqliteClient` uses one connection: an `ATTACH` run through the client is visible to the transaction that follows. With a connection pool the attach could land on a different connection than the transaction.

## Implication

Any later one-time copy between SQLite files follows the same order. Guard it with a row written in the same transaction as the copy, so a failed copy leaves no rows and the next start retries it.
