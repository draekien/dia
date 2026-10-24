# Eager and lazy plugin startup

Status: implemented (044be86, ADR-0027).

## Purpose

Startup waits only for the plugins an agent session needs (`load: "eager"`) and loads the others in the background, and every plugin state change reaches the renderer as an event so the UI shows plugins arriving (ADR-0027).

## Interface

```
src/shared/plugin/manifest.ts
  PluginLoadMode = 'eager' | 'lazy'
  PluginManifest.load?: PluginLoadMode            (absent = 'lazy')
  PluginStatus gains { _tag: 'Loading' }

src/shared/plugin/plugin-registry.ts
  PluginLoader.peek(root): Effect<PluginManifest, PluginLoadError>
  makePluginRegistry({ ..., onChange?: (changed: ReadonlyArray<PluginInfo>) => Effect<void> })
  PluginRegistry.start(): Effect<void>

src/shared/ipc/contract.ts
  PluginStatusChanged { name }                    (member of IpcEvent)
  PluginApi.onStatusChanged(listener): () => void
src/shared/ipc/rpc.ts
  PROTOCOL_VERSION = 5   (bumped to 5 by this change; now 7)

src/renderer/src/hooks/use-plugin-list.ts
  usePluginList(): { plugins | undefined, refresh }
src/renderer/src/components/
  plugin-load-indicator.tsx   PluginLoadIndicator()   header text, `Loading plugins 2 of 5`
  startup-skeleton.tsx        StartupSkeleton()       pane-area placeholder, `Starting dia`
  ui/skeleton.tsx             Skeleton                shadcn component
```

## Behaviour

- `start()` lists every plugin, marks each `Loading` (reported once, in name order), reads each manifest with `peek`, and loads the plugins with `load: "eager"` in name order. It also loads every adapter plugin in that group, whatever its `load` says (`docs/designs/adapter-category.md`). It resolves after the last eager plugin settled. It then forks the lazy loads, in name order, into the registry's scope and returns.
- A plugin whose manifest cannot be read is lazy; its load reports the failure as `Failed`.
- A plugin that `start` queued is skipped when `load` or `unload` was called for it before `start` reached it. The queue is a set of names; `load` and `unload` remove the name when called.
- `Loading` is set only on a plugin with no running version (`Unloaded` or `Failed`). A reload of a `Loaded` plugin keeps `Loaded`.
- After every `load`, `unload` and `start` marking, the registry compares each plugin's `PluginInfo` with the last one it reported (Schema equivalence) and calls `onChange` with the ones that differ. The first report covers every plugin the registry has seen.
- The Host's `onChange` publishes `PluginStatusChanged { name }` per changed plugin on the event hub, as a global event (no `paneId`), so it is never replayed.
- `usePluginList` reads `plugins.list` on mount and on every `PluginStatusChanged`; a response that a later read overtook is discarded.
- `host-main.ts` calls `start()` and then posts `HostReady`; the renderer's `startRendererPlugins` calls `start()` and `main.tsx` renders after it resolves.
- `PluginLoadIndicator` shows `Loading plugins <settled> of <total>` while at least one plugin is `Loading`, and nothing before the first list or when none is loading. Settled means not `Loading`.
- The plugins page shows three placeholder rows until its first list arrives, and for a `Loading` plugin the real name and folder, the text `Loading…`, a placeholder in place of the memory line and disabled actions.
- `StartupSkeleton` replaces the pane area while the layout is unavailable. Placeholder blocks stop animating under `prefers-reduced-motion`.

## Constraints

- The renderer cannot reach the Host before `HostReady`, so the `Starting dia` placeholder cannot name the plugin that is loading.
- Plugin state uses text only. Amber, red and green stay reserved for agent status (One Voice Rule).
- `PluginStatusChanged` is not replayed after a reconnect; a client re-reads `plugins.list` when its connection returns.
- A plugin that a first session needs must be `eager`; the registry does not infer it.
- `start` is called once per registry.

## Not covered

- Naming the loading plugin before `HostReady` (needs a main-process relay of Host progress).
- Per-plugin timing in the UI.
