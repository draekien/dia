---
status: accepted
date: 2026-11-13
decision-makers: William Pei
---

# Name every first-party plugin `dia-<name>`, and move each renamed plugin's data with a plugin data migration

## Context and Problem Statement

First-party plugin names are bare nouns (`chat`, `issues`, `mcp`), so a name does not show whether dia ships the plugin or a user wrote it. A plugin's `plugin.json` `name` is also its data folder, `<userData>/plugins/<name>` (`src/host/plugins/host-plugins.ts`), its import path, `@dia-plugin/<name>/<file>`, and a key in `settings.json` (`pluginOverrides`, adapter model preferences; `src/host/services/settings-store.ts`). The `worktrees` data folder holds live git worktrees (`plugins/worktrees/host.ts`, `join(ctx.dataDir, 'trees')`) and the `meta` data folder holds the meta repo (`plugins/meta/host.ts`). How should first-party plugins be named, and how does each plugin's data survive a rename?

## Decision Drivers

* A plugin's name shows that dia ships it.
* Each data folder's name matches its plugin's name.
* No rename loses data or breaks a worktree, a tab's working directory or a Claude Code transcript.

## Considered Options

* Rename every first-party plugin and move each data folder with a plugin data migration
* Rename every plugin and keep each data folder at its old name through a fixed map
* Prefix only plugins created from now on

## Decision Outcome

Chosen option: "Rename every first-party plugin and move each data folder with a plugin data migration", because folder names then match plugin names, and the data migration mechanism (ADR-0078) handles the references other owners hold.

* Every plugin under `plugins/` is named `dia-<name>`: the folder, the `plugin.json` `name`, and every `@dia-plugin/<name>` import. The plugins at 2026-11-13 are `adapters`, `agent-definitions`, `agent-overview`, `chat`, `claude-code`, `claude-code-settings`, `command-palette`, `example`, `issues`, `layout`, `mcp`, `meta`, `notifications`, `settings`, `skills`, `worktrees`, and `org` (moved to `archive/org` by ADR-0076).
* New first-party plugins take the prefix when created: `dia-runs`, `dia-run-events` (ADR-0074), `dia-tools` (ADR-0075), `dia-inbox` (ADR-0076).
* Each renamed plugin declares a data migration (ADR-0078) from `<userData>/plugins/<old>` to its own data folder. The migration of `dia-worktrees` repairs the git worktree links of every moved worktree; the migration of `dia-meta` moves the meta repo with it.
* The rename migrates the `settings.json` keys that hold a plugin name: `pluginOverrides` and adapter model preferences.

### Consequences

* Good, because a plugin name shows whether dia ships it, and its data folder has the same name.
* Bad, because every plugin's manifest and every cross-plugin import change at once.
* Bad, because the rename depends on data migrations working for live git worktrees and Claude Code transcripts on Windows.
* Bad, because import paths repeat the prefix (`@dia-plugin/dia-issues/service`).

## Pros and Cons of the Options

### Rename every plugin and keep each data folder at its old name through a fixed map

* Good, because no data moves and no reference changes.
* Bad, because 17 data folders keep names that no plugin has.

### Prefix only plugins created from now on

* Good, because no migration is needed.
* Bad, because names stay mixed permanently.

## More Information

* No `host.db` table stores a plugin name: `agents.model` holds a model id, and the other kernel tables hold paths, ids and events (checked 2026-11-13 against `src/host/services/kernel-migrations.ts`).
