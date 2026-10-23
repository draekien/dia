# Module eviction spike: the cordis eviction frees memory, but its native addon runs only on the exact Electron versions it lists

**Date:** 2026-10-24

## Context

Phase 2 reloads a plugin by importing its modules under new `?gen=<n>` URLs, so every reload adds module records that Node cannot free. cordis frees them by deleting entries from Node's internal ESM `loadCache`, which needs `--expose-internals` or the native addon `node-addon-require-builtin` (`packages/hmr/src/index.ts` and `packages/loader/src/internal.ts` in `cordiverse/cordis`). Phase 0 showed `--expose-internals` does not work in a packaged `utilityProcess` (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`). This spike checked whether the addon is a way around that, and how much memory `loadCache` deletion frees.

Test setup: Electron 43.1.0 (Node 24.18.0, V8 15.0.245.13-electron.0), Windows 11, `node-addon-require-builtin` 0.1.9 with its win32-x64 prebuilt binary, tsx from the repo. The memory runs used `ELECTRON_RUN_AS_NODE=1` with `--expose-internals --expose-gc`. A run reloads a plugin N times. The plugin module imports a `dep` module that exports an array of 200 000 numbers, unless the table says otherwise. Each reload rewrites both files and imports again. Heap is `process.memoryUsage().heapUsed` after two forced garbage collections.

## Reasoning / Learning

### Memory after reloading

| Method | Plugin files | Reloads | Heap, first to last |
| --- | --- | --- | --- |
| `registerHooks` resolve hook appending `?gen=<n>` (the Phase 2 loader) | `.js` | 300 | 2.6 MB to 244.4 MB |
| Delete the plugin's keys from `loadCache`, then import | `.js` | 300 | 2.6 MB to 4.3 MB |
| Same, with tsx registered | `.js` | 150 | 2.6 MB to 5.1 MB |
| Same | `.ts` through tsx | 150 | 3.6 MB to 125.6 MB |
| Same, after `process.setSourceMapsEnabled(false)` following tsx's `register()` | `.ts` through tsx | 100 | 5.2 MB at 50 reloads, 5.5 MB at 100 |
| `?gen=<n>` hook, modules with a 10-element array | `.js` | 1000 | 2.6 MB to 7.5 MB (about 5 KB per reload) |
| `?gen=<n>` hook, modules with a 10-element array | `.ts` through tsx | 300 | 3.5 MB to 7.6 MB (about 14 KB per reload) |

- **Deleting from `loadCache` frees the evaluated module.** Heap stays flat for `.js` modules.
- **tsx retains every evicted `.ts` module unless source maps are disabled.** tsx turns on `process.sourceMapsEnabled`. With it on, heap grows as if nothing were evicted; with it off, heap stays flat. Node's source map cache holding the module is the likely cause; it was not confirmed in Node's source.
- **Growth with the `?gen` hook depends on module size.** With 200 000-element arrays it is about 0.8 MB per reload. With near-empty modules it is 5 KB (`.js`) to 14 KB (`.ts` through tsx) per reload. The growth for a real plugin was not measured.

### The addon runs only on the Electron versions it lists

Each row ran `requireBuiltin('internal/modules/esm/loader')` in an unpackaged `utilityProcess`, with no Node flags.

| Electron | Node / V8 | Result |
| --- | --- | --- |
| 43.1.0 (dia's version) | 24.18.0 / 15.0.245.13 | `Unsupported/no-context` |
| 44.7.0 | 24.21.0 / 15.2.124.28 | Works. Heap 3.8 MB to 6.0 MB over 150 reloads of `.ts` modules through tsx, source maps disabled |
| 44.9.3 (latest 44.x) | 24.22.0 / 15.2.124.43 | `Unsupported/no-context` |
| 45.0.0 (latest) | 24.22.0 / 15.6.75.19 | `Unsupported/no-context` |

- **Error text.** "unsupported Electron runtime fingerprint: Node …, V8 … (supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6)".
- **Inside an asar.** On Electron 44.7.0 with the addon packed in an `app.asar` (`electron pack.asar`), the same test held heap at 3.8 MB to 5.6 MB over 100 reloads. The addon's loader copies its binary out of the asar before loading it.
- **Control.** Without the addon, the call throws `Cannot find module 'internal/modules/esm/loader'`.
- **How it works.** The error's diagnostics list `realm_slot`, `getter_address`, `vptr_image` and `offset`. The addon locates Node's builtin `require` by reading V8 and Node internals, and accepts only runtimes it has a fingerprint for.
- **Other facts.** The package is `deepseek-ai/dsh-node-addon-require-builtin`. `requireBuiltin(id)` forwards any internal module id. The 343 KB native binary was not audited. On first load the JavaScript loader copies the binary to `%LOCALAPPDATA%\node-addon-native-custom-loader\native-cache\<package>\<version>\<platform>\`.
- **Not tested.** A build made by electron-builder, Electron 43.0.0 and 44.0.0.

## Implication

- **Do not adopt the addon.** Using it means pinning Electron to 44.7.0, which is older than 44.9.3 and misses the fixes in 44.8 and 44.9. Every later Electron upgrade would need an addon release that lists it first. The addon also reads runtime internals by offset, and its native binary is unaudited. dia's Electron version (43.1.0) is not on its list.
- **If it is adopted later,** load it optionally and fall back to the `?gen` loader with a logged warning when it throws `Unsupported/no-context`, so an Electron upgrade does not stop plugins from loading.
- **Keep the Phase 2 `?gen` loader.** Phase 3 limits growth by bumping a module's generation only when its source changed (`docs/plans/2026-10-22-plugin-platform.md`, Phase 3 item 1).
- **If a way to reach `loadCache` is found later,** call `process.setSourceMapsEnabled(false)` after tsx's `register()`, or evicted `.ts` modules stay in memory. The cost is that stack traces from plugin `.ts` files show positions in the transformed code.
- **Per-reload growth of a real plugin is still unmeasured.** The table gives the scale for small modules only.
