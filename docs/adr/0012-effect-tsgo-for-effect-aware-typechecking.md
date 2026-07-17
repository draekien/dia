---
status: "accepted"
date: 2026-07-17
decision-makers: William Pei
---

# Use @effect/tsgo for Effect-aware type checking

## Context and Problem Statement

dia's main and pane processes are built on Effect TS (ADR-0009, ADR-0010). Effect has idiom pitfalls that the compiler alone does not catch — floating effects, chained `Effect.provide`, `Effect.fail` on already-yieldable errors, `Date`/`process.env` used inside effects. The Effect team ships a language service (`@effect/language-service`) that flags these. How should dia run those diagnostics both in-editor and in CI, given that the repo already pins `typescript@7.0.2` — the native Go compiler (tsgo)?

## Decision Drivers

* The installed `typescript@7` is the native tsgo build; its `tsc` is a shim that execs a Go binary, so there is no JavaScript `tsc`/`typescript.js` to patch.
* Diagnostics must surface both in-editor and from a headless `pnpm typecheck` (the lefthook pre-commit runs it), not only in one place.
* Whatever we adopt must track the installed Effect major version (currently `effect@3.21.4`), not a divergent line.

## Considered Options

* `@effect/tsgo` (the `effect-tsgo` binary — TypeScript-Go plus the Effect language service)
* Classic `@effect/language-service` + `effect-language-service patch` against a side-by-side classic TypeScript 6
* No language-service tooling (rely on `tsc` + review only)

## Decision Outcome

Chosen option: "`@effect/tsgo`", because it is the Effect team's supported path for the native compiler: `effect-tsgo patch` patches the native `tsc.exe` (with a restorable backup) so the existing `tsc`-based `pnpm typecheck` emits Effect diagnostics, and the same binary backs the editor language server. It needs no second TypeScript install and reuses the `typescript@7` already pinned.

### Consequences

* Good, because Effect diagnostics now fail `pnpm typecheck` (hence the pre-commit hook) on `error`-severity rules, catching idiom bugs before commit.
* Good, because the `@effect/language-service` plugin block lives once in `tsconfig.base.json`, inherited by `tsconfig.node.json`/`tsconfig.web.json` via `extends`, so both the CLI and the editor read one severity configuration.
* Bad, because `effect-tsgo patch` mutates the vendored native binary in `node_modules`; it must be re-applied after installs (wired via the `prepare` script) and is a moving target tied to tsgo internals.
* Bad, because the default severity map is aggressive for a codebase with legitimate boundary code (Electron entry, preload contextBridge, Vite config, node `path`/`fs`), so some rules are tuned down rather than obeyed.

## Pros and Cons of the Options

### @effect/tsgo

* Good, because it is purpose-built for the native compiler dia already uses.
* Good, because one binary serves both editor and CLI diagnostics.
* Bad, because it depends on binary patching of `node_modules` internals.

### Classic @effect/language-service + side-by-side TypeScript 6

* Good, because the classic patch mechanism is mature.
* Bad, because it requires installing and maintaining a second (classic) TypeScript purely for diagnostics, and the classic plugin explicitly does not support tsgo.

### No language-service tooling

* Good, because zero added tooling surface.
* Bad, because Effect idiom pitfalls stay invisible until review or runtime.

## More Information

- `scripts/prepare-effect.sh` pins the vendored Effect source (`.repos/effect`) to the `effect@3.21.4` tag so the `effect-ts` skill researches the version actually installed.
- Diagnostics can also be run explicitly: `effect-tsgo diagnostics --project tsconfig.node.json --format text`.
- Severity tuning lives in `tsconfig.base.json` under the plugin's `diagnosticSeverity` map.
