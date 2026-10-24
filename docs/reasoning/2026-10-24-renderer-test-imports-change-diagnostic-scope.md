# A renderer test that imports `App` makes `pnpm typecheck` warn about unrelated files

**Date:** 2026-10-24

## Context

An `app.test.tsx` rendered `<App />` to check that the startup placeholder shows until the layout arrives. `pnpm typecheck` then exited 1 with `src/renderer/src/components/pane-creation-form.tsx(61,6): warning TS377000: @effect-diagnostics directive has no effect`, in a file the change did not touch.

## Reasoning / Learning

`tsconfig.test.json` includes only test files, and the program contains every file the tests import. `App` imports `PaneTreeView`, which imports `pane-creation-form.tsx`, so that file entered the test project. There `asyncFunction` is `off` (`tsconfig.test.json`) while `tsconfig.base.json` has it as `warning`, so its `@effect-diagnostics-next-line asyncFunction:off` directive suppresses nothing and reports as unused. Deleting the `.tsbuildinfo` files did not change the result, so the cause was not a stale cache.

## Implication

A renderer test that imports an app root or a pane component pulls every transitive source file into the test project's diagnostics. Test leaf components (`StartupSkeleton`, `PluginLoadIndicator`) and leave the `App` wiring to a run of the real app, or give the affected file a directive that is valid in both projects.
