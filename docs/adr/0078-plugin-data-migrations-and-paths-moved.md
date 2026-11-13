---
status: accepted
date: 2026-11-13
decision-makers: William Pei
---

# A plugin declares data migrations that move its data, and the Host records each move so every owner of a path reference rewrites it

## Context and Problem Statement

A plugin stores files in `<userData>/plugins/<name>` (`ctx.dataDir`, ADR-0032) and migrates its database with keyed migrations (`ctx.database(migrations)`). No mechanism moves a plugin's data folder. A moved folder breaks references that other owners hold: tab working directories and worktree paths in `host.db` (kernel workspace store, ADR-0043), each repository's `.git/worktrees/<name>/gitdir` link (`dia-worktrees`), and Claude Code transcripts, which are stored per working directory under `~/.claude/projects/` (`dia-claude-code`; see `docs/reasoning/2026-07-17-worktree-reattach-resume-incantation.md`). ADR-0077 renames every first-party plugin, so every data folder moves. How does a plugin move its data, and how are references held by other owners rewritten?

## Decision Drivers

* A plugin moves its data without knowing which other owners hold paths into it.
* A move is applied once, survives a crash part-way, and never deletes either folder.
* An owner that is not loaded when a move happens still rewrites its references when it loads.

## Considered Options

* The Host moves folders and records a `PathsMoved` entry that each owner applies
* Each migration rewrites every reference itself
* The Host rewrites every reference itself

## Decision Outcome

Chosen option: "The Host moves folders and records a `PathsMoved` entry that each owner applies", because each owner then rewrites only references it owns, and a new owner of path references handles moves without changes to any migrating plugin.

* A plugin manifest lists data migrations in `dataMigrations`. Each migration has an `id`, a `from` path (relative to the user data folder) and an optional `before` module whose default export runs before the move and releases what holds the folder open (for example a `git fsmonitor--daemon`). A plugin fixes data it owns as a path owner of its own move, so a migration has no `after` step.
* Before a plugin's setup, the Host runs each migration the plugin has not run: it runs `before`, renames `from` to the plugin's data folder, and records the migration id in `host.db`, as `ctx.database` records database migrations. A rename that fails stops the plugin from loading with an error naming both paths and the cause, and is retried at the next load.
* If `from` and the destination both exist, the migration fails with an error naming both paths, and the plugin does not load. This covers dev builds that share `%APPDATA%\dia-dev` across worktrees (`docs/reasoning/2026-07-20-dev-prod-coexistence-userdata-isolation.md`).
* After a move the Host records a `PathsMoved` entry `{ from, to }` in `host.db`. An owner of path references (the kernel workspace store, `dia-claude-code`, `dia-worktrees`, and any later plugin) registers as a path owner and is given every entry it has not acknowledged, at load and when a new entry is recorded. It rewrites its references and acknowledges the entry.
* `dia-claude-code` handles an entry by moving the transcript folder of each moved working directory. `dia-worktrees` handles an entry by running `git worktree repair` with each moved worktree path.

### Consequences

* Good, because a plugin can change where it stores data at any time, not only during the ADR-0077 rename.
* Good, because a path owner that loads after the move still applies it.
* Bad, because every plugin that stores absolute paths must register as a path owner, or its paths break after a move.

## Pros and Cons of the Options

### Each migration rewrites every reference itself

* Good, because one migration file shows everything that changes.
* Bad, because every plugin that moves data must know every other owner of a path, including the adapter's transcript layout.

### The Host rewrites every reference itself

* Good, because plugins only fix their own data.
* Bad, because the kernel learns Claude Code's transcript layout, which ADR-0029 and ADR-0065 put behind the adapter.

## More Information

* Claude Code finds a session after its working directory and its transcript folder are both renamed, although earlier transcript entries keep the old `cwd` (verified 2026-11-13, `docs/reasoning/2026-11-13-plugin-data-move-hand-tests.md`).
* `git worktree repair <new paths>` run in the main repository restores the links of worktrees moved together with their parent folder on Windows (verified 2026-11-13, same entry). The move itself fails while a `git fsmonitor--daemon` watches a worktree, hence the `before` step.
* Amended 2026-11-13 by the design `docs/designs/plugin-data-migrations.md`: migrations are manifest data with an optional `before` module in place of migration modules with an `after` effect.
* Amends ADR-0032 (plugins keep files in a data directory).
