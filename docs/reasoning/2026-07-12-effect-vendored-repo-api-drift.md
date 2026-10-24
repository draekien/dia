# Vendored `.repos/effect` clone has a different API surface than the installed `effect` package

**Date:** 2026-07-12

## Context

The `/effect-ts` skill's setup step clones the upstream Effect repo into `.repos/effect` for source-level research. While refactoring `pane-supervisor.ts` and related modules, several APIs (`Stream.async`, `Effect.fn`, `Deferred`) needed exact-signature verification, and the clone did not match the installed package.

## Reasoning / Learning

The `.repos/effect` clone and the `effect` package in `node_modules` are versioned separately and can differ. A clone made by hand (for example from `main`, to read the v3 to v4 migration guides in `.repos/effect/migration/`) can be ahead of the installed version, and some signatures differ between versions. `pnpm prepare:effect` (`scripts/prepare-effect.sh`) clones the tag that matches the installed `effect` when `.repos/effect` does not exist yet, but it does nothing when the directory already exists. Checking `.repos/effect` first and trusting it can therefore produce code that does not match the installed package's types.

## Implication

Verify exact API signatures against `node_modules/effect/src/*.ts` or `node_modules/effect/dist/*.d.ts` (the installed version), not `.repos/effect/packages/effect/src/*`, even though the skill's own guidance says to use the vendored source for "exact API details." Use the vendored clone for concepts, patterns and migration guides; treat `node_modules` as the source of truth for what compiles. To refresh a stale clone, delete `.repos/effect` and run `pnpm prepare:effect`.
