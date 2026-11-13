# Dropping a parent table in SQLite runs its `ON DELETE SET NULL` actions at once

**Date:** 2026-11-09

## Context

Migration `9_agent_definitions` in `archive/org/migrations.ts` rebuilds `hired_agents` to remove its foreign key to `job_titles`. SQLite cannot drop a foreign key, so the migration creates `hired_agents_next`, copies the rows, drops `hired_agents` and renames `hired_agents_next` to `hired_agents`. `issues.assignee`, `objectives.assignee` and `issue_comments.author` reference `hired_agents(hire_id)` with `ON DELETE SET NULL`. Dia opens every database with `PRAGMA foreign_keys = ON`.

## Reasoning / Learning

- With `foreign_keys = ON`, `DROP TABLE hired_agents` first runs an implicit `DELETE FROM hired_agents`. That delete runs each child's `ON DELETE SET NULL` action at once, so every assignee and author becomes NULL before the rename.
- `PRAGMA defer_foreign_keys = ON` defers only the constraint check to the end of the transaction. It does not defer or skip the `ON DELETE` actions.
- `ALTER TABLE hired_agents_next RENAME TO hired_agents` rewrites references to the renamed table. Child tables whose foreign key text names `hired_agents` resolve to the renamed table, so their references are valid again after the rename.
- A node probe confirmed this. A mutation test also confirmed it: with the restore `UPDATE` removed, the `9_agent_definitions` test in `archive/org/migrations.test.ts` finds the assignees NULL.

The migration copies the child references into TEMP tables (`saved_issues_hires`, `saved_objectives_hires`, `saved_issue_comments_hires`) before the drop. After the rename, it writes them back with `UPDATE … FROM` and drops the TEMP tables.

## Implication

A migration that rebuilds a parent table with `ON DELETE SET NULL` or `ON DELETE CASCADE` children must save the child references, or child rows, before the `DROP TABLE` and restore them after the rename. Turning `foreign_keys` off is not possible inside the migration transaction: SQLite ignores that pragma while a transaction is open.
