---
status: "accepted"
date: 2026-10-24
decision-makers: William Pei
---

# Reload a plugin as a transaction with rollback, per-module generations and a memory limit

## Context and Problem Statement

ADR-0020 reloads a plugin by closing it and importing it again, and leaves a plugin unloaded when the reload fails. Node has no public API that evicts an ES module, so every reload under a new URL leaves module records in the Host's memory until the Host restarts. How does a reload avoid stopping a working plugin for a broken edit, and how does it bound the memory that reloads leave behind?

## Decision Drivers

* An agent or the user reloads a plugin repeatedly while editing it, and a typo must not stop the plugin that works.
* A packaged `utilityProcess` has no `--expose-internals`, so Node's module cache cannot be edited.
* The memory limit must be measurable without per-module accounting, which Node does not offer.
* The loader must not depend on a native addon that runs on only a fixed list of Electron versions.

## Considered Options

* Keep ADR-0020: close, import, and stay unloaded on failure; one generation per plugin root.
* cordis's approach: delete the plugin's keys from Node's internal `loadCache` through `node-addon-require-builtin`.
* Reload as a transaction: validate before stopping, restore on failure, one generation per module, and a per-plugin memory limit.

## Decision Outcome

Chosen option: "Reload as a transaction", because it keeps the running version on a failed reload, bounds growth by the number of source changes, and uses only public Node and V8 interfaces.

* The loader gives each module under a plugin root its own generation (`<url>?gen=<n>`). A load compares the size and modification time of every module imported for that plugin with the values at the previous load, and a changed module and its importers get a new generation. Other modules keep their URL, so they are not evaluated again.
* The registry validates the new version (manifest, API version, entry import) before it closes the running one. A failure there, or in the new setup, leaves the previous version running (or reopens it) with the failure in `Loaded.reloadError`. A first load that fails is `Failed`.
* The loader restores its generations, importer links and file signatures when the reload fails.
* A changed file outside the plugin directory that a plugin module imports directly gives `RestartRequired` with reason `dependency`; the running version stays.
* The registry totals, per plugin, the growth of the Host's heap across each load and unload, measured after a forced garbage collection. At 100 MB the plugin's `load` imports nothing and returns `RestartRequired` with reason `memory`; `unload` still works; a restart resets the totals.
* Agents reload plugins through three in-process MCP tools (`plugin_override`, `plugin_reload`, `plugin_clear_override`). Each tool asks the user itself, so approval holds in every permission mode that lets the tool run.

This supersedes the "Failed reload" row and the module-eviction wording of the HMR rows in ADR-0020. The Host file watcher and the renderer's Vite dev server in ADR-0020 are not built yet (paused by the user, 2026-10-24).

### Consequences

* Good, because a broken edit leaves the previous version running and reports the error on the plugin management page.
* Good, because an unchanged module is not evaluated again, so growth follows source changes: 200 edits of `plugins/example` added 2.6 MB to the plugin's total and 8 MB to the Host's working set.
* Good, because the loader uses no native addon and runs on the Electron version dia ships.
* Bad, because replaced module records are never freed; only a Host restart frees them.
* Bad, because the memory total is an estimate: other panes allocate while a load runs, and the first load of the first plugin includes costs that happen once in the Host (19.7 MB in the measured run).
* Bad, because the forced garbage collection relies on `v8.setFlagsFromString('--expose-gc')`, which Node documents as possibly doing nothing; it worked in the unpackaged Host and in vitest, and was not tried in a packaged build. When it is unavailable the total includes uncollected garbage and the Host logs a warning.
* Bad, because a change that keeps both the size and the modification time of a file is not detected.

## More Information

* `docs/designs/phase-3-plugin-loader.md`
* `docs/reasoning/2026-10-24-module-eviction-addon-spike.md`
* `docs/reasoning/2026-10-24-phase-3-research-findings.md`
* `docs/reasoning/2026-10-24-phase-3-implementation-findings.md`
