# A bundled `effect` in the Host fails plugin schema checks

**Date:** 2026-10-26

## Context

In the packaged app the `claude-code` adapter rejected a valid model list: `Schema.decodeUnknownEffect(Schema.NonEmptyArray(ModelOption))` failed with `Expected a value with a length of at least 1 at [0]["value"]` for a row whose `value` was `"default"`. The same code passed under vitest and in a plain Node script.

## Reasoning / Learning

* electron-vite bundled `effect` into `out/main/chunks/*.js` (39 `//#region node_modules/effect/dist` blocks). `out/main/plugin-api.js` built `ModelOption` with that bundled copy.
* The loader's resolve hook (`src/host/plugins/plugin-modules.ts`, `SHARED_LIBRARY`) resolves a plugin's `import 'effect'` from the Host's location, which Node resolves to `node_modules/effect`, not to the bundled chunk. The plugin therefore ran a second copy of `effect`.
* Decoding a schema from one copy with `Schema` functions from the other copy fails every refinement (`NonEmptyString`, `isPattern`). Schemas without refinements, such as `Question` in `session.ts`, decode correctly, which is why the mismatch went unnoticed.
* vitest and `electron-vite dev`-style runs load one `node_modules/effect`, so no test can show this.
* Fix: `ssr.external: ['@anthropic-ai/claude-agent-sdk', 'effect']` in `electron.vite.config.ts` (the `ssr.external` knob, not `rollupOptions.external`; see `2026-07-19-packaging-asarunpack-claude-cli.md`). After it, `out/main` imports `effect` and its subpaths from `node_modules`, and the Host and plugins share one copy.

## Implication

Keep `effect` in `ssr.external`. A plugin may decode or encode `@dia/plugin` schemas only while the Host and plugins share one `effect`. Prove a change that crosses the plugin boundary with a packaged build (`verify-in-app`), not with tests alone.
