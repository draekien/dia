---
status: "accepted"
date: 2026-11-17
decision-makers: William Pei
---

# Plugins that stay unloaded until the user loads them, and renderer entries that follow the Host

## Context and Problem Statement

`plugins/dia-example` loaded at every startup and added an `Example` page to the sidebar, although it exists only to show plugin authors the API. Settings › Plugins › Unload closed the plugin's Host entry only; its renderer entry kept running, so the `Example` page stayed in the sidebar until restart (`docs/reasoning/2026-11-07-settings-unload-keeps-renderer-entry.md`). How does a bundled plugin stay off until the user turns it on, and how does turning a plugin off remove its pages?

## Decision Drivers

* A plugin that is off must not show pages, panels or slot fillers.
* The Host registry and the renderer registry are separate instances of `makePluginRegistry` (ADR-0027) and must agree on which plugins run.
* A plugin can be loaded or unloaded from Settings, from the `plugin_reload` dia tool, or by a dependency closing.

## Considered Options

* Add `load: "manual"` to `PluginLoadMode`, and make the renderer registry follow the Host's `PluginStatusChanged` events.
* Add `load: "manual"`, and make Settings › Plugins call the renderer registry beside `window.dia.plugins`.
* Persist an enabled flag per plugin in settings.

## Decision Outcome

Chosen option: "Add `load: "manual"` and make the renderer registry follow the Host", because it covers every way a Host entry loads or unloads, not only the Settings buttons.

* `PluginLoadMode` is `'eager' | 'lazy' | 'manual'`. `PluginRegistry.start()` does not mark a `manual` plugin `Loading` and does not load it; it stays `Unloaded` until `load` is called. Both registries apply this, so the Host entry and the renderer entry both stay closed at startup.
* `plugins/dia-example` declares `"load": "manual"`.
* `followHostPlugins(renderer, window.dia.plugins)` (`src/renderer/src/plugins/renderer-plugins.ts`) runs after the renderer registry starts. It compares every renderer entry with the Host's `plugins.list` once when it starts, then the plugin named by each `PluginStatusChanged { name }`: when the Host reports the plugin `Unloaded` and its renderer entry is not `Unloaded`, it unloads the renderer entry; when the Host reports `Loaded` and the renderer entry is `Unloaded`, it loads the renderer entry.

### Consequences

* Good, because Settings › Plugins › Unload removes a plugin's pages and slot fillers, and Load adds them.
* Good, because a plugin author opts a bundled plugin out of startup with one manifest field.
* Bad, because the on/off choice is not persisted: after a restart a `manual` plugin is off again and every other plugin is on again.
* Bad, because a Host reload of a loaded plugin does not reload its renderer entry; the renderer entry is bundled with dia and does not change at runtime.

## Pros and Cons of the Options

### Add `load: "manual"` and make the renderer registry follow the Host

* Good, because the renderer follows unloads from every source.
* Bad, because status changes cost one `plugins.list` call per batch: the follower handles every plugin name that is waiting in one call. Carrying the new status in `PluginStatusChanged` would remove that call, but changes the IPC contract and `PROTOCOL_VERSION`.

### Add `load: "manual"` and make Settings call the renderer registry

* Good, because it changes one hook.
* Bad, because an unload from the `plugin_reload` tool or a closing dependency leaves the renderer entry running.

### Persist an enabled flag per plugin

* Good, because the user's choice survives a restart.
* Bad, because it needs a settings field, a migration and a UI control; nothing has asked for it yet.

## More Information

Amends ADR-0027 (load modes). Resolves the Settings › Unload consequence of ADR-0063.
