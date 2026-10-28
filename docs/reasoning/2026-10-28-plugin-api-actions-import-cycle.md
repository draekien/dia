# An import cycle through `plugin-api.ts` leaves `actions` unbound in the build

**Date:** 2026-10-28

## Context

In the dev build of issue #52, every agent-overview button that calls `actions.newAgent` did nothing. Calling the button's React `onClick` directly threw `TypeError: actions.newAgent is not a function`. All 1004 tests passed.

## Reasoning / Learning

`lib/actions.ts` imported `openSettings` from `components/settings/settings-dialog.tsx`. That file's imports reach `plugin-api.ts`: `settings-dialog` → `general-settings` → `transcript-width-toggle` → `plugin-api` → `lib/actions`. The renderer entry evaluates `lib/actions` first, so `plugin-api.ts` runs while `lib/actions` is still in progress, and `export const actions = { selectTab, newAgent, … }` captures each function before it is assigned. In the Rollup bundle the `var` declarations are hoisted, so the values are `undefined` and fail only when a plugin calls one. Under vitest the same order throws a TDZ `ReferenceError` instead, but only when a test imports `lib/actions` before `plugin-api`, and no component test did.

The fix moves `openSettings` and `SettingsLocation` to `components/settings/open-settings.ts`, which imports only `effect`. `src/renderer/src/plugin-api.test.ts` imports `lib/actions` and then `plugin-api` with dynamic imports (Biome sorts static imports) and asserts every `actions` member is a function.

## Implication

`lib/actions.ts` must not import a component module. A function it calls that lives beside a component goes in a module with no component imports. When a plugin action silently does nothing in the running app, check that the `actions` object in the built `actions-*.js` chunk is declared after the functions it lists.
