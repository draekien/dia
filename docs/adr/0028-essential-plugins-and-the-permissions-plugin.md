---
status: "accepted"
date: 2026-10-24
decision-makers: William Pei
---

# Keep essential plugins loaded and un-overridable, and move permission handling into one

## Context and Problem Statement

Phase 4 of the plugin platform (`docs/plans/2026-10-22-plugin-platform.md`) moves permission mode and pending user input out of the kernel. A plugin can be unloaded from the plugins page or by an agent, and can be replaced by an override that points at another directory. Unloading or replacing the code that answers `canUseTool` would remove the gate that decides whether a tool runs. Which plugins must the Host protect, and what does a session do when a protected plugin is unavailable?

## Decision Drivers

* A tool call must not run unprompted because a plugin was unloaded, failed to load, or was replaced.
* A plugin cannot be trusted to declare its own protection, because an override ships its own `plugin.json`.
* `session-reducer` has a safe minimal fallback (ADR-0019); permission handling has none.

## Considered Options

* `essential: true` in `plugin.json`.
* A list of essential plugin names owned by the kernel.
* Keep permission handling in the kernel and skip step 2.

## Decision Outcome

Chosen option: "A list of essential plugin names owned by the kernel", because an override's manifest cannot remove a protection the kernel holds.

* `ESSENTIAL_PLUGINS` in `src/shared/plugin/manifest.ts` lists `permissions`, `thinking` (Phase 4 step 3, `docs/designs/thinking-plugin.md`) and `git-ops` (Phase 4 step 4, `docs/designs/git-ops-plugin.md`). `session-reducer` is not essential.
* `PluginRegistry.unload` refuses an essential plugin. `PluginSources.setOverride` rejects one, and `PluginSources.resolve` ignores an override saved for one. Reload of the shipped copy stays allowed and keeps the reload transaction.
* `plugins/permissions` provides `pendingUserInput` and `permissionModeController`. The kernel creates both per agent session through `makeSessionPermissions`.
* When the plugin is unavailable (failed to load, or a factory is missing or throws), `canUseTool` denies every tool call except dia's own plugin tools, and emits no request.

### Consequences

* Good, because no plugin operation the Host exposes can remove the permission gate.
* Good, because a failed `permissions` plugin ends in denied tool calls, not allowed ones.
* Bad, because adding an essential plugin needs a kernel change, and the plugins page cannot show why a plugin is essential beyond a disabled `Unload`.
* Bad, because a user who edits `settings.json` by hand can still point `pluginOverrides` at a plugin name; the Host ignores it and logs a warning.

## Pros and Cons of the Options

### `essential: true` in `plugin.json`

* Good, because the flag sits beside the plugin it protects.
* Bad, because an override's `plugin.json` can omit it.

### A list of essential plugin names owned by the kernel

* Good, because the plugin cannot change it.
* Bad, because the list and the plugin directory are two places.

### Keep permission handling in the kernel

* Good, because there is no new failure mode.
* Bad, because step 2 of Phase 4 stays undone and permission handling stays unreplaceable by design instead of by rule.

## More Information

Design: `docs/designs/permissions-plugin.md`.
