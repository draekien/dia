# Session reducer plugin and the kernel seam

Status: superseded by `docs/designs/claude-code-adapter.md` (ADR-0029). The seam and plugin described here were removed; the code lives in the `claude-code` adapter.

## Purpose

The mapping from Agent SDK messages to the Host's `OutboundMessage` protocol (`agent-session-reducer.ts`) becomes the built-in plugin `session-reducer`. The kernel keeps `query()`, its input queue and its `sessionId` (ADR-0019), looks the mapping up by the service key `sessionReducer`, and keeps a minimal fallback so a streaming turn survives the plugin being unloaded, failing, or throwing.

## Interface

```
src/host/session/session-reducer-seam.ts                 (kernel)
  const SESSION_REDUCER_KEY = 'sessionReducer'
  interface SessionEventReducer { step(message: SDKMessage): ReadonlyArray<OutboundMessage> }
  type SessionEventReducerFactory = () => SessionEventReducer
  fallbackSessionEventReducer: SessionEventReducerFactory
  makeSessionReducer(registry: Pick<PluginRegistry, 'inject'>):
    Effect<{ step(message: SDKMessage): Effect<ReadonlyArray<OutboundMessage>> }>

src/shared/plugin/plugin-registry.ts
  interface PluginRegistry { inject(key: string): Effect<Option<unknown>> }

plugins/session-reducer/
  plugin.json   { name: 'session-reducer', api: '1', host: 'host.ts' }
  host.ts       ctx.provide(SESSION_REDUCER_KEY, makeSessionEventReducer)
  reducer.ts    makeSessionEventReducer (moved from src/host/session/agent-session-reducer.ts)
  reducer.test.ts

src/host/plugin-api.ts                                   (runtime entry of '@dia/plugin' on the Host)
  re-exports src/shared/plugin/api.ts, src/host/session/protocol.ts, and the seam's types and key

src/host/plugins/plugin-modules.ts
  makePluginModules(pluginApiUrl: string | undefined): PluginModules
src/host/plugins/host-plugins.ts
  makeHostPluginsLive(pluginApiPath: string): Layer<HostPlugins, never, PluginSources | EventHub | FileSystem | Path>
src/shared/ipc/host-process.ts
  HostInit gains pluginApiPath: string
```

## Behaviour

- `@dia/plugin` resolves to `src/shared/plugin/api.ts` for type checking in the renderer and to `src/host/plugin-api.ts` for the Host (`tsconfig.node.json`, `vitest.config.ts`). At runtime the loader's resolve hook maps it to the built `out/main/plugin-api.js` for any module under a plugin root. `plugin-api.js` and the Host bundle import one `protocol` chunk, so a plugin and the kernel hold the same schema instances (`docs/reasoning/2026-10-24-plugin-runtime-api-spike.md`).
- `makeSessionReducer` creates the reducer from the factory the registry holds for `SESSION_REDUCER_KEY` when it is a function. When no plugin provides the key, the value is not a function, or the factory throws, it uses `fallbackSessionEventReducer` and logs a warning or error that names the reason.
- `runSession` calls `makeSessionReducer` at every session start and restart, so a reload applies from the next start; a running turn keeps the reducer it started with.
- The `step` it returns never fails. When the plugin's `step` throws it logs the error, replaces the reducer with a fresh fallback for the rest of that session, and returns the fallback's output for the message that threw. Tool-call state held by the plugin's reducer is lost.
- `fallbackSessionEventReducer` emits `SessionStarted` for the `system` `init` message, `AssistantMessageReceived` for an `assistant` message with text, `TurnCompleted` for a successful `result`, and `TurnErrored` for any other `result`. It emits nothing else.
- `plugins/session-reducer` declares `load: "eager"`, and `host-main.ts` calls `PluginRegistry.start()` before it posts `HostReady`, so the first session finds the plugin while lazy plugins load afterwards (ADR-0027, `docs/designs/lazy-plugin-startup.md`). A plugin that fails to load is a status and does not stop startup.
- The six messages the kernel builds itself (`PermissionRequested`, `QuestionRequested`, `PlanReviewRequested`, `PermissionModeChanged`, `SlashCommandsWarming`, `RewoundToCheckpoint`) are unchanged.
- `PLUGIN_API_VERSION` stays `'1'`: the change adds exports and a service key, and a plugin that does not use them runs as before.

## Constraints

- `plugins/session-reducer` imports only `effect`, `@dia/plugin` and type-only imports of `@anthropic-ai/claude-agent-sdk` and `@shared/domain/pane`, because a shipped plugin cannot import `src/`.
- `makeHostPluginsLive` builds one `PluginModules` per Host process. Building the layer twice in one process installs two resolve hooks.
- The location of `plugin-api.js` comes from `HostInit.pluginApiPath` (`join(app.getAppPath(), 'out', 'main', 'plugin-api.js')` in main). `HostInit` is a main-to-Host message, not part of `DiaRpcs`, so `PROTOCOL_VERSION` does not change.

## Refinement record

| # | Finding | Rule | Tag | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `loadAll` ran after `HostReady`, so the first session could start on the fallback. | Correctness | major | Applied: `loadAll` runs before `HostReady`. Later replaced by eager `start()` (ADR-0027). |
| 2 | A reducer that throws mid-stream ended the turn stream. | Define errors out of existence | major | Applied: `makeSessionReducer` guards `step`. |
| 3 | The seam's types reference `SDKMessage` and the host protocol, which `src/shared` must not import. | Project rules (ADR-0013) | major | Applied: host-only exports live in `src/host/plugin-api.ts`. |
| 4 | `plugins/**/*.test.ts` was outside the vitest include. | Correctness | minor | Applied. |
| 5 | `processPluginModules` is built before `HostInit` arrives. | Information hiding | minor | Applied: `makePluginModules(pluginApiUrl)` built in `makeHostPluginsLive`. |
| 6 | Bumping `PLUGIN_API_VERSION` to `'2'` would refuse `plugins/example`, and the change is additive. | Correctness | minor | Rejected: version stays `'1'`. |

Changes made during implementation: resolving the provider and guarding `step` are one exported function, `makeSessionReducer`, instead of two (callers depend on the behaviour, not on the two steps), and `step` returns an `Effect` so the guard can log and switch reducers with a `Ref`. The fallback also emits `AssistantMessageReceived`, at the user's request.
