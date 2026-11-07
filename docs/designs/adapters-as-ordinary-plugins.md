# Adapters as ordinary plugins

An adapter plugin (today only `plugins/claude-code`) loads, reloads, unloads, takes a worktree override, injects services, uses `whenProvided` and imports other plugins' exports under the same rules as a feature plugin. `category` remains in `plugin.json` as a label that the Adapters settings page and model preferences read. After this change no registry, loader or source rule branches on it; the registry only copies it into `PluginInfo`.

Scope: layer (plugin registry, plugin loader and sources, agent backend seam, plugin settings UI). Decisions confirmed by the user on 2026-11-07:

1. A worktree override of an adapter, and any other plugin, may provide `agentBackend` and answer `canUseTool`. `ServiceKeyReservedError` is removed because `category` is a label only (decision 3). ADR-0065 records that the guarantee of ADR-0028 and ADR-0029 (only the shipped adapter answers permission prompts) no longer holds.
2. A running `AgentSession` keeps the adapter code it was opened with until the session ends. Sessions opened later use the reloaded adapter. deepseek-harness does the same: a request binds to the adapter generation that dispatches it (`deepseek-harness/packages/llm/llm/README.md:129`).
3. `category` is a label only.

## Current state (read at `b778e2e`)

| # | Location | Adapter-only rule today | After |
|---|---|---|---|
| 1 | `src/shared/plugin/manifest.ts:71-140` | `AdapterManifest`: `host` required; `renderer`, `inject`, `load` are `Schema.Never`; `PluginManifest` is a union of two structs | One `PluginManifest` struct with `category: 'feature' \| 'adapter'`; every other field is shared. `AdapterManifest` and `FeatureManifest` exports are deleted. The `PluginCategory` JSDoc states it is a label. `host` is optional for an adapter too. Test fixtures that import `FeatureManifest` (`list-slots.test.tsx`, `plugin-messages.test.ts`, `renderer-registry.fake.ts`, `plugins/layout/renderer.test.ts`, `plugins/org/host.test.ts`, `plugin-registry.test.ts`) import `PluginManifest` |
| 2 | `plugin-registry.ts:1148` `loadModeOf` | An adapter is always `eager` | `manifest.load ?? 'lazy'` for every plugin. `plugins/claude-code/plugin.json` gains `"load": "eager"` |
| 3 | `plugin-registry.ts:1015-1017` | `load` of a running adapter is refused | Removed |
| 4 | `plugin-registry.ts:1067-1076` `refuseUnload` | `unload` of an adapter is refused | Removed |
| 5 | `plugin-registry.ts:40-46, 304-312, 878-896`; `agent-backend.ts:347-354`; `host-plugins.ts:87`; `renderer-plugins.ts:77`; `renderer-registry.fake.ts:41`, `list-slots.test.tsx:50`, `plugin-messages.test.ts:61`, `plugins/layout/renderer.test.ts:54`, `plugins/org/host.test.ts:70` | `AdapterContract` (`keys`, `problems`) checked after an adapter's setup | `AdapterContract`, its check and the `adapterContract` dependency are deleted. `ctx.provide(AgentBackendKey, value)` fails to compile for a value that is not an `AgentBackend` (ADR-0060), and `AgentBackendKey.is` makes an invalid value read as not provided with the log `A provided service failed its key check` (ADR-0062). ADR-0065 records that a plugin that provides nothing under `agentBackend` now loads without error |
| 6 | `plugin-registry.ts:484-491`; `ServiceKeyReservedError` in `api.ts:52-60, 113, 117`, `plugin-registry.ts:20, 41`, `src/renderer/src/lib/slots.tsx:5, 70`, `list-slots.ts:3, 102` | A feature plugin may not provide `agentBackend` | Removed, with `ServiceKeyReservedError`. Two providers of `agentBackend` already fail with `ServiceKeyTakenError` |
| 7 | `plugin-registry.ts:544-545` | An adapter that reads a key via `inject` fails | Removed |
| 8 | `plugin-registry.ts:267-274, 564-565` | `ctx.whenProvided` from an adapter fails with reason `'adapter'` | The `'adapter'` refusal is removed from `WhenProvidedRefusal` |
| 9 | `plugin-sources.ts:73-95`, callers at 129 and 148-151 | An override of an adapter, or an override directory that declares an adapter, is refused by `resolve` and `setOverride` | `declaresAdapter` and `overrideRefusal` are deleted, with the now unused `decodeManifest` import |
| 10 | `plugin-modules.ts:40, 46, 61, 146-155, 266, 281, 317`; `plugin-loader.ts:73, 82`; `fixtures/plugin-modules-driver.mjs:20-24, 148-151` | An adapter that imports another plugin's export throws | The check is removed. `category` is removed from `declare`, `transact` and the module record. The driver fixture's `adapter` importer becomes a plain plugin |
| 11 | `agent-backend.ts:338-373`; `biome-plugins/noRegistryInject.grit:8` | `resolveAgentBackend` uses `inject` under a biome-ignore that says an adapter never reloads; the lint message allows `inject` "only for an adapter plugin's service" | `resolveAgentBackend` stays on `inject`. The lint message becomes: use `inject` only for a value read again each time `changes` emits its key, or for a value whose holder runs in the caller's scope. The biome-ignore reason and the JSDoc of `resolveAgentBackend` and `AgentBackendKey` say: a session runs in its caller's scope, so a reload does not end it. ADR-0065 records why `use` is rejected: its lease ends when `openSession` returns, so it would not cover the session |
| 12 | `plugins/settings/plugin-settings.tsx:139-188` (including "Set folder" at 167) | Reload, Unload and Set folder are disabled for an adapter; "Restart dia to apply a change" | The adapter branch is deleted; an adapter row is the same as a feature row |

Unchanged readers of `category` as a label: `plugins/adapters/adapter-settings.tsx:72` (lists adapters), `src/host/services/model-preferences.ts:56` (picks the loaded adapter's preferences).

## Why a running session survives a reload

`AgentBackend.openSession` (`agent-backend.ts:193-195`) returns `Effect<AgentSession, never, Scope>`: the session, its `query()` stream, its tool server and its pending `canUseTool` requests live in the pane's scope (`plugins/claude-code/session.ts:764-784`). `registry.inject` takes no lease (`plugin-registry.ts:476`), so a reload neither waits for nor interrupts a session. Closing the claude-code plugin scope closes only what `setup` acquired: the SDK warning listener, the install override, the model catalog and the health status ref (`plugins/claude-code/host.ts`). The session copied the install path when it opened (`session.ts:765, 777`). A reload imports the entry at a new module URL, so the old module stays loaded while the old session references it. That retained module counts toward the plugin's reload memory limit: once it is reached, the next reload reports `RestartRequired` (`plugin-registry.ts:1026-1034`).

One reference from a session into the plugin scope remains: `openClaudeCodeSession` receives `health.reportStartupFailure`, which updates the old health `SubscriptionRef` (`health.ts:273-287`). After a reload that update is not shown, because `AdapterStatusFeed` follows the new backend. The failure is still logged (`health.ts:275`). This is accepted.

What a reload does to other readers:

| Reader | Effect of a claude-code reload |
|---|---|
| `SessionFactory.start` (`pane-supervisor.ts:207`) | Resolves the backend once per session. A session opened between the close and the reopen gets `unavailableBackend` and ends with `The claude-code adapter is not loaded`; accepted |
| `ModelCatalogFeed`, `AdapterStatusFeed` | `agentBackendChanges(...).pipe(Stream.switchMap(...))` switches to the new backend |
| `TranscriptReader`, `rpc-handlers.ts:358-362`, `refresh`, `check`, `setInstallPath` | Resolve once per call |
| org `holdAgentBackend` (`plugins/org/host.ts:28-38`) | `whenProvided` closes on reload (`closeDependantsOf`, `plugin-registry.ts:735-754`) and reopens with the new backend; `bypassAvailable` is false in between |
| A plugin export claude-code imports | Its reload closes and reloads claude-code (`closeImporters`, `plugin-registry.ts:926-943`), with the effects above |
| No provider (unloaded or failed) | `unavailableBackend`: sessions end with `The claude-code adapter is not loaded` |

## Interface changes

```ts
// src/shared/plugin/manifest.ts
export const PluginCategory = Schema.Literals(['feature', 'adapter'])
export const PluginManifest = Schema.Struct({ category: PluginCategory /* , every existing feature field */ })

// src/shared/plugin/plugin-registry.ts — deleted: AdapterContract; PluginRegistryDeps loses `adapterContract`
// src/shared/plugin/api.ts — deleted: ServiceKeyReservedError
// HostPluginContext.provide: Effect<void, ServiceKeyTakenError, Scope>
```

`PLUGIN_API_VERSION` is bumped from 0.0.28, and `api` in every `plugins/*/plugin.json` is set to the new version; the registry refuses a plugin that declares an older one. Its JSDoc names the change.

## Docs

- New ADR `0065-adapter-plugins-are-ordinary-plugins.md`. It supersedes ADR-0029's category rules (the "Hot reload", "Worktree override" and "Can be unloaded" columns, the adapter contract and the `inject` ban). ADR-0029's decision to put the Agent SDK behind one adapter interface stays. It records decisions 1 and 2, the loss of the adapter contract's load failure, that an adapter manifest may omit `host`, and why `resolveAgentBackend` uses `inject` and not `use`.
- Status lines "amended by ADR-0065": ADR-0019 (line 85, "cannot be hot reloaded"), ADR-0027 (adapter always eager), ADR-0029, ADR-0055 (`inject` exemption reason), ADR-0056 (`whenProvided` adapter refusal), ADR-0059 ("Adapters" row), ADR-0062 (`adapterContract` reporting), ADR-0063 line 31 (adapter has no renderer entry). Index updated.
- `docs/reasoning/2026-10-25-schema-union-needs-required-discriminator.md` and its `docs/REASONING.md:51` line are rewritten or deleted, because the manifest union no longer exists.
- JSDoc of `PluginRegistry`, `PluginCategory`, `resolveAgentBackend` and `AgentBackendKey` updated.

## Tests

| Success criterion | Test |
|---|---|
| claude-code can import another plugin's export | `plugin-modules.test.ts:162` and its driver case are deleted: `PluginModules` no longer receives a category, so no import rule can depend on it. The existing "imports of another plugin's exports" cases cover every importer |
| An adapter reloads and unloads | `plugin-registry.test.ts`: "unloads an adapter like any other plugin" and "reloads a running adapter, closing it and running its setup again" |
| A worktree override of an adapter loads | `plugin-sources.test.ts:219-276` flips: `resolve` and `setOverride` accept it |
| An adapter may `inject` and use `whenProvided` | `plugin-registry.test.ts`: "lets an adapter read a service it declares in inject" and "runs the setup an adapter plugin registers" |
| Any plugin may provide `agentBackend` | 1129 is deleted: the registry no longer holds a list of reserved keys, so no case can fail |
| A session opened before a reload completes its turn and resolves a permission prompt | In-app check (verify-in-app): start a turn that asks permission, reload claude-code from Settings › Plugins, approve, the turn completes |
| A session opened after a reload uses the new backend | `agent-backend.test.ts`: `resolveAgentBackend` after a provider change returns the new value |
| Unloading claude-code ends new sessions with `The claude-code adapter is not loaded` | Existing `agent-backend.test.ts` case for `unavailableBackend`, plus the in-app check |
| Manifest | `manifest.test.ts:28-57` flips: an adapter manifest with `inject`, `renderer` and `load` decodes; the 'reports every adapter problem' case is deleted. Lines 59-74 keep the missing and unknown `category` cases with the message `plugin.json must declare "category" as "feature" or "adapter"`, kept as an annotation on the `category` field |
| Settings UI | `plugin-settings.test.tsx:290, 309` flip: Reload, Unload and Set folder are enabled for an adapter |

Deleted with the contract: `plugin-registry.test.ts` 1108, 1156, 1650 and the `requiresBackend` contract at lines 113 and 285. Lines 1195-1214: the adapter fixture gets `load: 'eager'`. The `AdapterManifest` import and `adapterManifest` helper (lines 16, 42) move to the single manifest.

## Out of scope

- The `mcp` plugin and moving `McpServer` out of the kernel (next PR).
- A renderer entry for claude-code; the Claude Code settings panel stays in `plugins/claude-code-settings`.
- Ending running sessions when their adapter is unloaded.

## Refinement Record

**Applied**
- Round 1: the loss of the adapter contract's load failure is recorded; decision 1 covers any plugin (confirmed by the user); the `noRegistryInject.grit` message and the reason for `inject` over `use`; the reload effects table; the compile-time fallout rows; corrected test lines and deleted cases; the reload memory limit; the docs list (ADR-0019, the manifest-union reasoning entry, `PLUGIN_API_VERSION` and every `plugin.json`).
- Round 2: an adapter manifest may omit `host`; the missing-`category` message stays as a field annotation; six more fixtures that import `FeatureManifest` or pass `adapterContract`; two more `ServiceKeyReservedError` sites; the lead paragraph names what still reads `category`.

**Rejected**
- An `agentBackendProblems` check in `plugins/claude-code` setup: `ctx.provide(AgentBackendKey, …)` is typed (ADR-0060), `makeClaudeCodeBackend` returns an `AgentBackend`, and `agentBackendProblems` is not exported from `@dia/plugin`.
