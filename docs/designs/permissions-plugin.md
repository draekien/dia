# Essential plugins and the permissions plugin

Status: superseded by `docs/designs/claude-code-adapter.md` and `docs/designs/adapter-category.md` (ADR-0029). `permission-mode-controller` moved into the `claude-code` adapter, `PendingUserInput` moved into the kernel (`src/host/session/pending-user-input.ts`), and `plugins/permissions`, `ESSENTIAL_PLUGINS` and the essential-plugin rules were deleted.

## Purpose

The permission-mode state (`PermissionModeController`) and the registry of pending tool-permission, question and plan-review requests (`PendingUserInput`) become the built-in plugin `permissions`. The kernel keeps `canUseTool` and the Agent SDK `query()`, looks both services up by service key, and denies every tool call when the plugin is not available. `permissions` is the first essential plugin: the Host refuses to unload it or to load an override of it.

## Interface

```
src/shared/plugin/manifest.ts
  const ESSENTIAL_PLUGINS = ['permissions'] as const
  isEssentialPlugin(name: string): boolean

src/host/session/permissions-seam.ts                      (kernel)
  PENDING_USER_INPUT_KEY         = 'pendingUserInput'            value: () => PendingUserInput
  PERMISSION_MODE_CONTROLLER_KEY = 'permissionModeController'    value: () => Effect<PermissionModeController>
  interface PendingUserInput, UserInputResolution, Superseded      (contract, moved from pending-user-input.ts)
  interface PermissionModeController, LivePermissionQuery          (contract, moved from permission-mode-controller.ts)
  makeSessionPermissions(registry: Pick<PluginRegistry, 'inject'>):
    Effect<{ pendingUserInput, modeController, available: boolean }>

plugins/permissions/
  plugin.json   { name: 'permissions', api: '1', host: 'host.ts', load: 'eager' }
  host.ts       provides both keys
  pending-user-input.ts, permission-mode-controller.ts, and their tests

src/host/plugin-api.ts
  re-exports the two keys, the contract types and Superseded
```

## Behaviour

- `ESSENTIAL_PLUGINS` is a kernel constant. A plugin cannot declare itself essential or remove its own flag, because an override's `plugin.json` is not consulted.
- `PluginRegistry.unload` of an essential plugin logs a warning and returns its current `PluginInfo`; the plugin stays loaded. `load` (reload) of an essential plugin is allowed and keeps the reload transaction: a failed reload keeps the running version.
- `PluginSources.setOverride` of an essential plugin fails with `InvalidOverrideError`, which `applyOverride` reports as `Rejected`. `PluginSources.resolve` ignores an override already in `settings.json` for an essential plugin, logs a warning, and returns the shipped copy.
- `makeSessionPermissions` is called once per `makeAgentSession`. It uses both factories when the registry holds a function for each key; otherwise it logs a warning that names the missing or malformed key and returns inert services with `available: false`. The inert controller never changes the mode (`applyMode` logs a warning, `currentMode` is `None`, `resolvePlan` is `None`); the inert registry resolves nothing.
- `canUseTool` checks `available` first. When it is `false` it denies the call with `Permission handling is unavailable: the permissions plugin is not loaded.` and emits no request, so the renderer shows no card nobody can answer. Plugin tool names are allowed before the check, as before.
- A reload of `permissions` applies from the next `makeAgentSession`; a running session keeps the instances it created.
- `PluginInfo` is unchanged, so `PROTOCOL_VERSION` stays 5. The plugins page imports `isEssentialPlugin` from `@shared` and disables `Unload` for an essential row.

## Constraints

- `plugins/permissions` imports only `effect`, `@dia/plugin`, and type-only imports of `@anthropic-ai/claude-agent-sdk`, `@shared/domain/pane` and `@shared/domain/attention`, because a shipped plugin cannot import `src/`.
- `Superseded` is a runtime value the kernel (`toPermissionResult`) and the plugin both use, so it is exported from `@dia/plugin` and the kernel imports it from the same module the plugin resolves.

## Refinement record

| # | Finding | Rule | Tag | Outcome |
| --- | --- | --- | --- | --- |
| 1 | An `essential` flag in `plugin.json` is read from an override's own manifest, so an override could remove it. | Correctness | major | Applied: kernel constant. |
| 2 | The inert services would still let `canUseTool` emit a `PermissionRequested` card nobody can answer. | Define errors out of existence | major | Applied: `available` is checked first and the call is denied without emitting. |
| 3 | The essential check is in the registry and in `PluginSources`. | Information hiding | minor | Rejected: both read one constant; the registry owns unload, the sources own override. |
| 4 | `plugin-api.ts` must export the contract types and `Superseded`. | Project rules (a shipped plugin cannot import `src/`) | minor | Applied. |
