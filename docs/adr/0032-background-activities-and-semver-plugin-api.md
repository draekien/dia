---
status: accepted
date: 2026-10-26
decision-makers: William Pei
---

# Plugins schedule background activities through the kernel, keep files in a data directory, and declare a semver plugin API version

## Context and Problem Statement

The New agent form listed a hard-coded set of models that went out of date (issue #33). The current list comes from the Agent SDK's `supportedModels()`, which starts a Claude Code process, so it has to be read in the background, cached across restarts, and refreshed daily and on demand. No part of dia ran scheduled work, plugins had no place to keep files, and the plugin API version was a single integer (`"1"`) that a host compared for equality, so adding a context member would refuse every existing plugin.

## Decision Drivers

* The adapter owns the knowledge of what to read and when it is stale; the kernel must not learn about models.
* The user must see and trigger each piece of scheduled work from one place (the Plugins page).
* Adding a member to the plugin context must not refuse plugins built against the previous context.

## Considered Options

* Background activities registered by plugins and run by a kernel scheduler, plus a per-plugin data directory
* Each plugin runs its own timers inside its setup scope
* The kernel stores the model list and schedules the probe itself

## Decision Outcome

Chosen option: "Background activities registered by plugins and run by a kernel scheduler, plus a per-plugin data directory", because the plugin decides what to run and when it is next due, while the kernel provides one list of every activity with its status and a run-now control.

* `HostPluginContext.activities.register(spec)` registers an activity in the plugin's setup scope. The kernel (`src/host/services/background-activities.ts`) runs `spec.run` when it is due; `run` returns the next due time or fails with `ActivityRunFailed { retryAt }`. The kernel persists nothing; an activity is removed when its plugin's scope closes.
* `HostPluginContext.dataDir` is `<userData>/plugins/<name>`, created before setup runs. The plugin owns its files.
* `PLUGIN_API_VERSION` is a semver string, `0.0.1` while dia is in development. A plugin loads when the host satisfies npm's caret range of its `api`: from 1.0.0, the same major version and a minor version no higher than the host's; below 1.0.0, the same minor version; below 0.1.0, the same patch version. A bare `"1"` is refused. This replaces the equality rule in ADR-0019's "Plugin API versioning" bullet.
* `PROTOCOL_VERSION` (`src/shared/ipc/rpc.ts`), the renderer-to-Host protocol version, is also a semver string, `0.0.1`. The Host accepts a client only when it offers exactly that version.

### Consequences

* Good, because a plugin adds scheduled work without kernel changes, and the Plugins page lists it with a Run now button.
* Good, because from 1.0.0 a host can add context members in a minor version without refusing older plugins. Below 0.1.0 every API change refuses older plugins, which suits development, when the plugin context changes often.
* Bad, because every shipped `plugin.json` had to change its `api` value to a semver string.
* Bad, because the kernel holds no due times across restarts; each plugin derives its first due time from its own files at setup.

## Pros and Cons of the Options

### Each plugin runs its own timers inside its setup scope

* Good, because no kernel service is needed.
* Bad, because the user cannot see or trigger the work from one place, and every plugin re-implements scheduling.

### The kernel stores the model list and schedules the probe itself

* Good, because no plugin API change is needed.
* Bad, because the kernel would depend on what an adapter reports and when it goes stale, which ADR-0029 places in the adapter.

## More Information

* Spec: `docs/designs/model-catalog.md`.
* Amends ADR-0019 (plugin API versioning) and builds on ADR-0029 (the adapter owns the Agent SDK).
* SDK probe findings: `docs/reasoning/2026-10-26-supported-models-probe.md`.
