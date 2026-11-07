---
status: "accepted, amended by ADR-0060 and ADR-0065"
date: 2026-11-07
decision-makers: William Pei
---

# Run part of a plugin while optional services are provided

## Context and Problem Statement

A plugin that lists a service key in `plugin.json` `inject` waits, as a whole, while no plugin provides that key; a plugin that does not list it cannot read it (`ServiceNotDeclaredError`, issue #186). The agent overview (#182) should list hired agents while the `org` plugin is loaded and keep working without them while it is not. How does a plugin depend on a service optionally, so that only the part that uses the service stops when its provider closes?

## Decision Drivers

* A plugin's dependants must close before its provider closes, so no plugin keeps a closed value (ADR-0019, issue #186).
* cordis declares an optional dependency only at a call, `ctx.inject(keys, callback)`, which creates a child plugin that runs while `keys` are provided (`cordiverse/cordis` `packages/core/src/registry.ts:227`); deepseek-harness uses the same call (`packages/core/agent-loop/src/index.ts:358`). Neither has a static optional list.
* Every plugin open and close runs under the registry lock (`Semaphore(1)`), which is not reentrant.
* Adapter plugins do not depend on feature plugins (ADR-0029).

## Considered Options

* `ctx.whenProvided(keys, setup)`, called during setup, where `setup` receives the values
* An `"optional"` list in `plugin.json` that `whenProvided` checks against
* A cordis-style child context passed to `setup`
* `whenProvided` callable at any time while the plugin is loaded

## Decision Outcome

Chosen option: "`ctx.whenProvided(keys, setup)`, called during setup, where `setup` receives the values", because it follows cordis and deepseek-harness in declaring the dependency at the call, needs no second context, and never takes the registry lock.

* `PluginServices.whenProvided(keys, setup)` registers `setup` for the lifetime of the scope it is called in. The registry runs `setup` in a child scope of that scope, with the value of each key, once the registering setup has succeeded and every key is provided by a running plugin. It closes the child scope before a provider of any key closes, and runs `setup` again when every key is provided again.
* Closing a child scope first closes the plugins and `whenProvided` setups that depend on keys provided inside it, as closing a plugin does.
* A failing or timed-out `setup` closes only its child scope and is logged; the plugin stays `Loaded`.
* `whenProvided` may be called only by a feature plugin, during its setup or an enclosing `whenProvided` setup; any other call fails with `WhenProvidedRefusedError`.
* Keys passed to `whenProvided` need no entry in `plugin.json` `inject`.
* `PLUGIN_API_VERSION` becomes `0.0.21` (ADR-0032).

### Consequences

* Good, because a plugin keeps running while an optional provider is unloaded, and only the part that uses the service stops and restarts.
* Good, because no plugin or child keeps a value from a closed provider, including keys provided inside a child.
* Bad, because `setup`s run one after another under the registry lock with a 10-second limit each, so slow ones delay other loads and unloads.
* Bad, because closing a child does not wait for `registry.use` leases on keys it provided (ADR-0055 drains leases per plugin).
* Bad, because a dependency known only after setup (a setting turned on later) must be written as one `whenProvided` in setup that reacts inside its `setup`.

## Pros and Cons of the Options

### An `"optional"` list in `plugin.json`

* Good, because every service a plugin reads is listed in one file.
* Bad, because neither cordis nor deepseek-harness has one, and it is a second list that can drift from the calls.

### A cordis-style child context passed to `setup`

* Good, because code ported from cordis keeps its shape.
* Bad, because dia ties lifetimes to Effect's `Scope`, not to the context, so the child context would only widen one `inject` check, and needs a second host and renderer context through `deps.extend`.

### `whenProvided` callable at any time

* Good, because a plugin can add a dependency it learns of after setup.
* Bad, because a call outside setup must take the registry lock, a call inside setup must not (the lock is not reentrant), and a call from a `registry.use` lease during an unload waits up to 30 seconds. No caller needs it.

## More Information

* Amends ADR-0019's plugin context and lifecycle; relies on ADR-0029 (adapters) and ADR-0032 (plugin API version).
* Design: `docs/designs/plugin-when-provided.md`. Issue #188.
