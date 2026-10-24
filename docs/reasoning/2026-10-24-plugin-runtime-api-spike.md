# Plugin runtime API spike: `@dia/plugin` as a runtime import

**Date:** 2026-10-24

## Context

The SDK message → protocol mapping moved into a built-in plugin (now `plugins/claude-code/reducer.ts`). The reducer builds `SessionStarted.make(...)`, `TurnErrored.make(...)` and the other protocol messages, which are runtime schema values in `src/host/session/protocol.ts`. A plugin shipped under `plugins/` cannot import them: `electron-builder.yml` packages `out/**` and `plugins/**` only, and `@dia/plugin` resolved only through `tsconfig.base.json` `paths` (a type-only alias with no runtime alias in `electron.vite.config.ts` or `vitest.config.ts`). The options were `ctx.protocol`, a runtime `@dia/plugin`, or building built-in plugins into `out/`.

## Reasoning / Learning

cordis and deepseek-harness both hand shared values to a plugin by `import` from a package (`import { defineTool } from '@deepseek-ai/dsh-tools'`, `import { Service, Inject } from 'cordis'`) and hand live host instances through injection (`ctx.tools`, `ctx.timer`). deepseek-harness resolves a plugin's `dsh-*` peers to the host's single copy through a resolve table installed on Node internals; its built-in plugins are compiled (`lib/index.js`, `src` unpublished). Sources: `cordiverse/cordis@35fdc96`, `deepseek-ai/deepseek-harness@22ddee3`; read by a documentation lookup, not run.

dia's loader already redirects `effect` imports made from a plugin to the Host's copy in `registerHooks({ resolve })` (`plugin-modules.ts`). The spike added one case to that hook and one build input:

```ts
if (specifier === '@dia/plugin' && pluginApiUrl !== undefined && parentRoot !== undefined) {
  return { url: pluginApiUrl, format: 'module', shortCircuit: true }
}
```

```ts
input: { index: …, host: resolve('src/host/index.ts'), 'plugin-api': resolve('src/host/plugin-api.ts') }
```

with `src/host/plugin-api.ts` containing `export * from './session/protocol'`.

Results:

| Check | Result |
| --- | --- |
| Build output | `out/main/plugin-api.js` and `chunks/host-main-*.js` both import the single `chunks/protocol-*.js`, so the kernel and a plugin hold the same schema instances. |
| Unpackaged app (`electron .`) | An override folder `host.ts` that imports `SessionStarted` and `TurnCompleted` from `@dia/plugin` loaded (`Loaded`), and its own log line printed `started: "SessionStarted"`. |
| Packaged app (`electron-builder --win --dir`, `dia.exe --user-data-dir=<scratch>`) | The same override folder reported `Loaded` with `plugin-api.js` read from `app.asar`. The packaged log stopped after startup and had no probe lines, so the plugin's own log line is unconfirmed there. `.make` on an undefined import throws, which would have reported `Failed`. |

The spike derived the location of `plugin-api.js` from `import.meta.url` of the bundled host chunk (`new URL('../plugin-api.js', import.meta.url)`), which holds only while the chunk sits one directory below the entry. The Host now receives the location explicitly as `pluginApiPath` (`src/main/index.ts` passes `out/main/plugin-api.js`; `src/host/plugins/host-plugins.ts` converts it to the URL the resolve hook returns).

## Implication

Runtime `@dia/plugin` works for override folders and built-in plugins in both builds, and the Host passes its location through `pluginApiPath`. Building built-in plugins into `out/` would not remove the need for it, because an override folder is source and still needs the protocol values. Not checked: a Windows NSIS install.
