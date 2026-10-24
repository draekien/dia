# Plugin runtime API spike: `@dia/plugin` as a runtime import

**Date:** 2026-10-24

## Context

Phase 4 step 1 moves the SDK message → protocol mapping (`agent-session-reducer.ts`) into a built-in plugin. The reducer builds `SessionStarted.make(...)`, `TurnErrored.make(...)` and the other protocol messages, which are runtime schema values in `src/host/session/protocol.ts`. A plugin shipped under `plugins/` cannot import them: `electron-builder.yml` packages `out/**` and `plugins/**` only, and `@dia/plugin` resolved only through `tsconfig.base.json` `paths` (a type-only alias with no runtime alias in `electron.vite.config.ts` or `vitest.config.ts`). The options were `ctx.protocol`, a runtime `@dia/plugin`, or building built-in plugins into `out/`.

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

The location of `plugin-api.js` was derived from `import.meta.url` of the bundled host chunk (`new URL('../plugin-api.js', import.meta.url)`), which holds only while the chunk sits one directory below the entry. A real implementation needs an explicit location, for example one supplied through `HostInit`.

## Implication

Runtime `@dia/plugin` is viable for override folders and built-in plugins in both builds. Building built-in plugins into `out/` would not remove the need for it, because an override folder is source and still needs the protocol values. A real implementation must pass the `plugin-api.js` location explicitly instead of deriving it from a chunk path, decide what `@dia/plugin` exports at runtime, and bump `PLUGIN_API_VERSION` to `'2'` when it does. Not checked: a Windows NSIS install, and a Host started with the built-in `session-reducer` plugin present.
