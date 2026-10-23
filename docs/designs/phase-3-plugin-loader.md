# Phase 3 plugin loader, rollback and memory safeguard

## Purpose

A plugin reload imports only the modules whose source changed, validates the new version before the running one stops, restores the previous version when the new one fails, and refuses further reloads of a plugin once its loads have grown the Host's heap by 100 MB.

## Interface

```
src/shared/plugin/plugin-registry.ts
  class PluginRestartRequiredError { reason: 'dependency' | 'memory'; message: string }
  interface LoadedPlugin<Context> { manifest; resolveSetup }
  interface PluginLoader<Context> {
    load<A, E, R>(root, use: (loaded: LoadedPlugin<Context>) => Effect<A, E, R>):
      Effect<A, E | PluginLoadError | PluginRestartRequiredError, R>
  }
  interface PluginMemoryGuard { limit: number; used(plugin): Effect<number>; track<A, E, R>(plugin, effect): Effect<A, E, R> }
  makePluginRegistry deps gain optional `memory: PluginMemoryGuard`

src/host/plugins/plugin-modules.ts
  interface PluginModules { transact<A, E, R>(root, use: Effect<A, E, R>): Effect<A, E | PluginRestartRequiredError, R>; importEntry(root, entry): Promise<unknown> }
  processPluginModules: PluginModules

src/host/plugins/module-generations.ts
  class ModuleGenerations { versioned(url): string; recordImport(importer, imported): void; invalidate(changed): ReadonlySet<string>; snapshot(): () => void }

src/host/plugins/plugin-memory-guard.ts
  makePluginMemoryGuard({ limit, heapUsed: Effect<number> }): PluginMemoryGuard
  heapUsedAfterGc: Effect<number>
```

`PluginLoader.load` runs `use` after reading the manifest and detecting changed files. It rolls loader state back when `use` fails. It fails with `PluginRestartRequiredError('dependency')` before `use` when a file outside the plugin root that a plugin module imports directly has changed.

## Key data structures

```
PluginStatus: Unloaded | Loaded { reloadError?: string } | Failed { message } | Waiting { missing } | RestartRequired { reason: 'dependency' | 'memory'; message }
PluginInfo { name; origin; root; status; memoryBytes (number >= 0) }
```

Generation: one process-wide counter. A module's generation is the counter value when it was last invalidated. An unseen module has generation 0. The versioned URL is `<url>?gen=<generation>`.

## Registry load, in order

All steps run inside `loader.load(root, ...)`, under the registry lock, inside `memory.track`.

1. Refuse: when `memory.used(name) >= memory.limit`, the status is `RestartRequired('memory')`. Nothing is imported or changed.
2. Validate: manifest checks (API version, name), then `resolveSetup`. A failure leaves the running version running with `Loaded { reloadError }`. With no running version the status is `Failed`.
3. Swap: close dependants and the running scope, then open the new setup. A setup failure reopens the previous setup with `Loaded { reloadError }`. With no previous setup the status is `Failed`.
4. A failure in step 2 or 3 fails the transaction, so the loader restores its generations, importer edges and file signatures.

## Internal decomposition

- `ModuleGenerations` owns the identity of each module version and the importer relation.
- `PluginModules` owns the resolve hook, the file signatures (size, modification time) and the transaction.
- `PluginMemoryGuard` owns the per-plugin totals.
- The registry owns lifecycle. It knows nothing about URLs, signatures or the heap.

## Memory total

After each tracked operation: `total = max(0, total + (after - before))`. Both `load` and `unload` are tracked. Heap is read after a garbage collection. `heapUsedAfterGc` calls `v8.setFlagsFromString('--expose-gc')`, then `vm.runInNewContext('gc')` once. When that is unavailable it measures without a collection and logs a warning.

The Node documentation says of `v8.setFlagsFromString` that changing settings after the VM has started "may result in unpredictable behavior, including crashes and data loss; or it may simply do nothing" (https://nodejs.org/docs/latest-v24.x/api/v8.html). The `--expose-gc` plus `vm.runInNewContext('gc')` combination is not documented, and its behavior in a packaged `utilityProcess` is `unverified`. The total is an estimate.

## Design rationale

- **Transaction instead of a revert call.** Loader state changes survive only a successful load, whichever step fails.
- **Signatures checked at load.** A reload by hand or by an agent finds exactly the files that changed. No watcher is needed.
- **Monotonic generation counter.** A rollback restores a module's old generation but never reuses a number.
- **Heap growth attributed to the plugin being loaded.** Node has no per-module memory accounting. Other panes allocate during a load, so the number is an estimate.

## Rejected alternatives

- **Registry calls `revert`.** A missed failure path serves stale code.
- **Sum of source file sizes as the memory measure.** It misses module-level data, which dominated growth in the spike (`docs/reasoning/2026-10-24-module-eviction-addon-spike.md`).
- **cordis `loadCache` eviction through an addon.** It runs only on Electron 43.0.0, 44.0.0, 44.7.0 and 45.0.0-alpha.6.
