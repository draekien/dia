# Plugin platform Phase 0 spike: Host process type, module eviction, kernel query, WebSocket handshake

**Date:** 2026-10-22

## Context

Phase 0 of `docs/plans/2026-10-22-plugin-platform.md` (issue #5) verifies four assumptions behind ADR-0019 to ADR-0022 before Phase 1 builds the Host. The spike ran on branch `spike/plugin-platform-phase-0`.

Test setup:
- Electron 43.1.0, which bundles Node 24.18.0; tsx 4.23.15; esbuild 0.28.2; Windows 11.
- Each check ran from `electron .` (unpackaged) and from `electron-builder --win --dir` output (`dist/win-unpacked/dia.exe`, packaged). The results were the same in both except where this entry says otherwise.
- The Host entry was a prebuilt JS file inside `app.asar`. It imported a TypeScript fixture from `%TEMP%`, outside the app, in the same position as a plugin override in a worktree. The fixture was `plugin.ts`, which imports `./dep` with no extension (the repo's convention) and declares an `interface`.
- Eviction test: write both files at generation 1, import, rewrite both at generation 2, import again. A pass returns `{ plugin: 2, dep: 2 }`.

## Reasoning / Learning

### Results

| Check | Result | Fallback needed |
| --- | --- | --- |
| Host process type | Pass for an `ELECTRON_RUN_AS_NODE` child with `--import tsx`. A `utilityProcess` does not run `--import`, but it passes when the Host entry calls `register()` from `tsx/esm/api` itself | No |
| Module eviction | Pass, by cache-busting URLs applied to the plugin's whole import graph | No. Old module instances stay in memory, as the plan's fallback column already accepts |
| Kernel-owned `query()` | Pass. Packaged run: plugin scope closed at kernel event 23, reopened at event 64, the query finished with `success` after 1032 events, and the closed scope's subscriber received no events after the close | No |
| WebSocket handshake | Pass. A `file://` renderer page connected to `ws://127.0.0.1:<port>` with the token and received an echo. A connection with no token and one with a wrong token both closed with code 1006 | No |

### Host process type

| Host process and loader setup | Unpackaged | Packaged |
| --- | --- | --- |
| `utilityProcess`, `execArgv: ['--import', <tsx loader URL>]` | Fail: `Cannot find module '…\loader\dep' imported from …\plugin.ts` | Same |
| `utilityProcess`, Host entry calls `register()` from `tsx/esm/api` | Pass | Pass with `ESBUILD_BINARY_PATH` |
| `ELECTRON_RUN_AS_NODE` child, `--import <tsx loader URL>` | Pass | Pass with `ESBUILD_BINARY_PATH` |

- **`utilityProcess.fork` accepts `--import` in `execArgv` but does not run it.** `process.execArgv` in the child lists the flag. A `--import` pointing at a file that does not exist started without an error. `plugin.ts` itself loaded through Node 24's built-in type stripping, but the extensionless `./dep` failed to resolve. Nothing tsx does was active. The reason `--import` is skipped was not determined. Electron's `docs/api/utility-process.md` (v43.1.0) documents `execArgv` and no restriction on it.
- **tsx can stay inside `app.asar`.** `--import file:///…/resources/app.asar/node_modules/tsx/dist/loader.mjs` and `import('tsx/esm/api')` both work from the asar path.
- **esbuild cannot run from inside `app.asar`.** esbuild has no asar handling and spawns `…\app.asar\node_modules\@esbuild\win32-x64\esbuild.exe`, which fails with `ENOENT`. A packaged Host needs both of:
  - `node_modules/esbuild/**` and `node_modules/@esbuild/**` in `asarUnpack` in `electron-builder.yml`;
  - `ESBUILD_BINARY_PATH` set to the `app.asar.unpacked` copy of the binary.
- **`tsx`, `tsx/esm/api` and `esbuild` must be external in the electron-vite `main` build** (`build.rollupOptions.external` in `electron.vite.config.ts`). electron-vite 5.0.0 bundled the dynamic `import('tsx/esm/api')` into `out/main/chunks/`, and tsx then failed with `The esbuild JavaScript API cannot be bundled`.

### Module eviction

| Method | Result (both builds unless noted) |
| --- | --- |
| `import(url + '?v=2')` on the entry only | `{ plugin: 2, dep: 1 }`. Only the entry reloads; its imports keep their cached instances |
| `module.registerHooks` resolve hook that appends `?gen=<n>` to every URL under the plugin's root, with tsx registered | `{ plugin: 2, dep: 2 }` |
| `tsImport(url, parentURL)` from `tsx/esm/api` | `{ plugin: 2, dep: 2 }` |
| `--expose-internals`, delete the plugin's keys from the ESM loader's `loadCache` (cordis's method) | `{ plugin: 2, dep: 2 }` in an `ELECTRON_RUN_AS_NODE` child. In a packaged `utilityProcess`: `Cannot find module 'internal/modules/esm/loader'`, although `process.execArgv` lists `--expose-internals` |

- **A plugin directory must resolve to `"type": "module"`.** With no `package.json` that sets `"type": "module"` above the plugin, tsx compiles the `.ts` files to CommonJS. Node's CommonJS `require` cache then returns the old instances, and none of the ESM methods above reload them; every method returned `{ plugin: 1, dep: 1 }`. Plugins under `plugins/` in the dia repo resolve to the root `package.json`, which sets `"type": "module"`.
- **A `registerHooks` resolve hook works whether tsx was registered by `--import tsx` (in an `ELECTRON_RUN_AS_NODE` child) or by `register()` (in a `utilityProcess`).** Node 24 documents `module.registerHooks` (in-thread, with `deregister()`) as the replacement for `module.register`, which is deprecated since v24.15.0. Node has no public API that removes a module from the ESM cache (`doc/api/module.md`, v24.18.0).
- **Cache-busting does not free the old instances.** Each reload adds module records under new URLs. Memory growth per reload was not measured.

### WebSocket handshake

- Server: Effect 4.0.5 `NodeHttpServer.layer(() => createServer(), { host: '127.0.0.1', port: 0 })` with `HttpServer.serve`. The handler returns `401` when the token is missing or wrong, and calls `request.upgrade` when it is present. `@effect/platform-node` uses `ws` for the upgrade, so no new dependency is needed.
- A browser `WebSocket` cannot set request headers. The token was sent as the subprotocol `dia.token.<64 hex chars>` (`new WebSocket(url, ['dia.token.' + token])`). The Host checks the `Sec-WebSocket-Protocol` header. `ws` accepts the first offered subprotocol by default, which the browser requires for the handshake to complete.
- The renderer does not see the `401`. A refused connection is reported to page code as `close` with code 1006, the same code as any other failed handshake.
- Not tested by the spike:
  - passing the port and token through the preload (`webContents.executeJavaScript` injected them);
  - the dev-mode `http://localhost` renderer origin;
  - checking the `Origin` header;
  - a Content-Security-Policy. `src/renderer/index.html` has none today; a CSP added later must allow `connect-src ws://127.0.0.1:*`.

## Implication

- **Host process:** run it as a `utilityProcess`. Its entry calls `register()` from `tsx/esm/api` before loading any override. Pass the Host no Node flags, and set `ESBUILD_BINARY_PATH` to the unpacked esbuild binary when `app.isPackaged`. This keeps the Host independent of the `runAsNode` fuse: Electron's `docs/tutorial/fuses.md` (v43.1.0) says `child_process.fork` stops working when that fuse is disabled, and recommends `utilityProcess`.
- **ADR-0020 does not need its external-watcher fallback.** Its HMR row ("evicts those modules") is implemented as a per-plugin generation counter in a `module.registerHooks` resolve hook, not as cordis's `loadCache` deletion: `--expose-internals` is unavailable in a packaged `utilityProcess`. A long session leaks one set of module instances per reload.
- **Plugin loader:** refuse an override whose directory does not resolve to `"type": "module"`.
- **Host transport:** send the token in the `Sec-WebSocket-Protocol` subprotocol, and expect the renderer to see a refused connection as close code 1006. The items listed as not tested under "WebSocket handshake" in this entry are still open.
