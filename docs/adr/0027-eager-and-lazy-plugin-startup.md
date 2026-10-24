---
status: "accepted"
date: 2026-10-24
decision-makers: William Pei
---

# Load plugins as eager or lazy at startup, and report each plugin's progress to the renderer

## Context and Problem Statement

The Host loaded every plugin before it posted `HostReady`, so a first agent session found the `session-reducer` plugin (ADR-0019, `docs/designs/session-reducer-plugin.md`). A plugin that nothing in a first session needs still delayed the window, and the renderer showed a blank window until the last plugin loaded. How does startup wait only for plugins a session needs, and how does the renderer show the others arriving?

## Decision Drivers

* A session that starts before `session-reducer` loads runs on the minimal fallback reducer and shows no streaming, tool calls or checkpoints.
* A plugin that fails to load must not stop startup.
* The renderer cannot reach the Host before `HostReady`, because the WebSocket port and token arrive with it.
* The plugin management page and the header must show state that changes while the Host loads.

## Considered Options

* Load every plugin before `HostReady` (the behaviour before this decision).
* Load every plugin after `HostReady` and let a session that starts early use the fallback reducer.
* Mark each plugin `eager` or `lazy` in its manifest: `HostReady` waits for eager plugins only.

## Decision Outcome

Chosen option: "Mark each plugin `eager` or `lazy` in its manifest", because it keeps the first-session guarantee for the plugins that provide it and removes the wait for the rest.

* `plugin.json` gains `load: "eager" | "lazy"`; absent means `lazy`. `plugins/session-reducer` is `eager`.
* `PluginRegistry.start()` marks every plugin `Loading`, loads the eager plugins one after another, and resolves when each has settled (loaded, waiting, failed or restart-required). The lazy plugins keep loading in a fiber forked into the registry's scope. `host-main.ts` calls `start()` and then posts `HostReady`.
* A plugin the caller unloads or loads before `start` reaches it is skipped. The registry tracks the names `start` queued, and `load` and `unload` remove a name when they are called, because the registry's lock does not order a queued `unload` before the next load of the loading fiber (`docs/reasoning/2026-10-24-lock-does-not-order-queued-unload.md`).
* `PluginStatus` gains `Loading`: a first load is queued or running and no version runs. A reload of a running plugin stays `Loaded`.
* The registry reports every changed `PluginInfo` to an `onChange` callback. The Host publishes a `PluginStatusChanged { name }` event on the event hub, and the renderer re-reads `plugins.list` on each one. The event carries no state and is not replayed. `PROTOCOL_VERSION` becomes 5, because the event union of `SubscribeEvents` changed.
* The renderer's registry follows the same flag. `main.tsx` renders after the eager renderer plugins settle.
* Progress shows in three tiers. Before `HostReady`, the pane area shows a `Starting dia` placeholder (`StartupSkeleton`). The renderer cannot name the plugin being loaded at that point. After `HostReady`, the header shows `Loading plugins 2 of 5` until none is `Loading` (`PluginLoadIndicator`), and the plugins page shows placeholder rows before its first list and a `Loading…` row for each loading plugin. Plugin state uses text only, never amber, red or green (One Voice Rule).

### Consequences

* Good, because the window and the first session wait for the eager plugins only.
* Good, because a failing or slow lazy plugin cannot delay startup.
* Good, because every plugin state change, including user reloads, reaches the renderer without polling.
* Bad, because a plugin that must be present for correct behaviour has to declare itself `eager`; a lazy plugin that provides a service an early session reads is missing for that session.
* Bad, because an eager plugin that injects a service from a lazy plugin settles as `Waiting`, which counts as settled and does not delay `HostReady`.
* Bad, because a renderer built for protocol version 4 cannot connect to this Host.

## Pros and Cons of the Options

### Load every plugin before `HostReady`

* Good, because the first session always finds every plugin.
* Bad, because startup time grows with each plugin, and the renderer shows a blank window meanwhile.

### Load every plugin after `HostReady`

* Good, because the window appears at once.
* Bad, because a first session on the fallback reducer shows no streaming or tool calls, and the reducer a session picked stays for that session.

### Mark each plugin `eager` or `lazy`

* Good, because the author of a plugin states whether a session needs it.
* Bad, because it adds a manifest field and a status.

## More Information

Spec: `docs/designs/lazy-plugin-startup.md`. Extends ADR-0019 and ADR-0026.
