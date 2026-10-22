# Vendored `.repos/effect` clone has a different API surface than the installed `effect` package

**Date:** 2026-07-12

## Context

The `/effect-ts` skill's setup step clones the upstream Effect repo into `.repos/effect` for source-level research. While refactoring `pane-supervisor.ts`/`gateway.ts`/`agent-session.ts`, several APIs (`Stream.async`, `Effect.fn`, `Deferred`) needed exact-signature verification.

## Reasoning / Learning

The vendored clone at `.repos/effect` tracks `effect-smol`, which is a newer/different package from whatever `effect` version is actually installed in `node_modules` (this project has `effect@3.21.4` installed). Some signatures genuinely differ between the two — checking `.repos/effect` first and trusting it would have produced code that doesn't match the installed package's types.

## Implication

Always verify exact API signatures against `node_modules/effect/src/*.ts` or `node_modules/effect/dist/*.d.ts` (the installed version), not `.repos/effect/packages/effect/src/*` (the vendored research clone), even though the skill's own guidance says to use the vendored source for "exact API details." Treat the vendored repo as conceptual/pattern reference only; treat `node_modules` as the source of truth for what will actually compile.

**Update (2026-10-22):** dia now runs Effect v4 (`effect@4.0.5`). `scripts/prepare-effect.sh` clones the canonical `Effect-TS/effect` repo at the installed tag, so a fresh `.repos/effect` matches `node_modules`. A `.repos/effect` cloned by hand (for example from `main` for the v3 → v4 migration guides in `.repos/effect/migration/`) can still be ahead of the installed version, so the rule above still applies.
