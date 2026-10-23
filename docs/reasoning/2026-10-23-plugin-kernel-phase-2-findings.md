# Plugin platform Phase 2: plugin entries are functions, shared libraries resolve to the Host's copy, failures carry plain messages

**Date:** 2026-10-23

## Context

Phase 2 of `docs/plans/2026-10-22-plugin-platform.md` (issue #7) added the plugin manifest, a registry with one `Scope` per plugin, a loader with per-plugin overrides, and a renderer registry. Designing and running it produced four findings that are not visible from the code.

Test setup for the manual run: Windows 11, Electron 43.1.0, built with `pnpm build` and run with `electron .` (unpackaged), driven over the Chrome DevTools Protocol with `window.dia.plugins` calls. The override plugin lived in a temporary directory with no `node_modules`.

## Reasoning / Learning

### A plugin entry exports a function, not a `Context.Service` tag

The context a plugin receives (`PluginContext`) is passed as the argument of the plugin's default export: `export default (ctx) => Effect.gen(...)`. The first design had plugins `yield*` a service tag imported from dia. That would need the tag's module to exist at runtime for a plugin that lives outside the app, and a second copy of the module would be a second tag. A function argument needs no import: `import type { HostPluginContext } from '@dia/plugin'` is erased when tsx compiles the plugin, so the alias `@dia/plugin` exists only in `tsconfig.base.json`.

### `effect` imported from an override resolves to the Host's copy

An override directory in a worktree may have no `node_modules`, and one that has them would load a second copy of `effect`, so `Context` keys and `Scope` instances would not be shared. The loader's `module.registerHooks` resolve hook rewrites the parent URL of any `effect` or `effect/*` import made from a module under a plugin root to the loader's own URL. The manual run loaded an override with no `node_modules`; its `import { Effect } from 'effect'` worked and its two reloads each evaluated the new `dep.ts` (`v1`, then `v2`).

### `Cause.pretty` is the wrong source for a failure message shown to a user

The first `Failed` status used `Cause.pretty`, which appends the stack trace. The test for a missing renderer entry caught it. The registry now takes the message of `Cause.squash(cause)`, so a `PluginLoadError` shows its own message and a thrown `Error` shows its message. A syntax error in a plugin still produces a long message: the text is esbuild's, prefixed by tsx's CommonJS-shim preamble. It is not trimmed.

### A reload runs dependants down before the provider and back up after it

When plugin B provides `db` and plugin A injects it, loading B again closes A (A becomes `Waiting`), closes B's old scope, opens B, then reopens A with the value B provides now. The registry serialises every `load` and `unload` with one semaphore; the test "runs concurrent loads one after another" fails when the lock is removed from `load` (checked by deleting it). A plugin scope is a fork of the registry's scope and the context carries no handle to a pane session, so closing it cannot interrupt a streaming turn. In the manual run, 20 reloads over 5.1 s during a 1500-line reply left the stream with 1500 contiguous lines and a final message equal to the streamed text.

## Implication

- The loader reads the manifest and defers the entry import (`resolveSetup`) so the registry checks the API version and name first; a plugin built for another version never runs its top-level code.
- Keep the plugin context free of kernel handles (`PaneSupervisor`, `query()`); a plugin that needs one gets a narrower service added to the context deliberately.
- Add shared runtime libraries to the resolve hook's list when a plugin needs another one (`react` for renderer plugins in Phase 3).
- A reload leaks module instances, as the Phase 0 entry records; the per-reload growth is still not measured.
- The Host auto-loads every known plugin at startup. Whether a plugin the user unloaded stays unloaded after a restart is not persisted.
- The renderer registry is not driven by the Host's `LoadPlugin` calls; connecting them is part of Phase 3.
