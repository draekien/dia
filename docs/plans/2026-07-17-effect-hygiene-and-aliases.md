# Plan: Effect hygiene, tooling, and path aliases

Status: **complete** — all phases (0–4) landed; `pnpm typecheck` (3 configs), `pnpm test`
(114/114), and `pnpm build` green with 0 Effect diagnostics.
Date: 2026-07-17
Driven by: Effect LSP (`@effect/tsgo`) diagnostics + two audit subagents (composition/data-types, tagged-types/pattern-matching), reconciled against `effect@3.21.4`.

## Context already established this session

- **LSP tooling**: `typescript@7.0.2` is the native Go compiler (tsgo). The classic `@effect/language-service` patch is incompatible; `@effect/tsgo` is the native path and is now installed. `effect-tsgo patch` has patched the native `tsc.exe` (backed up), so a normal `tsc` run *can* emit Effect diagnostics — but only where the plugin is configured.
- **Vendored repo** (`.repos/effect`): swapped from `effect-smol@4.0.0-beta.97` to `Effect-TS/effect @ packages/effect@3.21.4`, matching the installed package. `scripts/prepare-effect.sh` updated to pin that tag. (Done.)
- **Version guardrail**: recommendations are validated against installed `effect@3.21.4`; 4.0-only APIs (e.g. `Schema.TaggedUnion` with built-in `.match`) are **out of scope**.

## Current diagnostics (baseline, via `effect-tsgo diagnostics`)

`src/main/**` + `src/preload/**`: **2 errors, 26 warnings, 9 messages**. Renderer: 0.

| Rule | Sev | Count | Where |
|---|---|---|---|
| `floatingEffect` | error | 2 | `pending-user-input.test.ts:66,67` |
| `multipleEffectProvide` | warning | 26 | mostly `*.test.ts` chained `Effect.provide` |
| `unnecessaryFailYieldableError` | message | 8 | `git-ops-service.ts`, `pane-supervisor.ts`, `pane-workspace.ts` |
| `runEffectInsideEffect` | message | 1 | `index.ts:117` |

---

## Phase 0 — Wire diagnostics into `pnpm typecheck`

Goal: diagnostics surface from the normal typecheck, not just an ad-hoc `--lspconfig`.

- The `@effect/language-service` plugin block is currently only in the base `tsconfig.json`. The two compiling configs (`tsconfig.node.json`, `tsconfig.web.json`) don't extend it, so `tsc -p …` checks 0 files for Effect rules.
- Introduce a shared `tsconfig.base.json` carrying the plugin block (+ shared `paths`, see Phase 1); have `tsconfig.node.json`/`tsconfig.web.json` `extends` it. Keep the solution `tsconfig.json` as references-only.
- Verify `pnpm typecheck` now emits the diagnostics; confirm `floatingEffect` (error) makes typecheck fail until fixed.

## Phase 1 — TS path aliases (main / preload / renderer)

Consult `docs/llms/electron-vite.txt` before touching vite config.

- Aliases: keep `@renderer/*`; add `@main/*` → `src/main/*` and `@preload/*` → `src/preload/*`. Declare once in `tsconfig.base.json`, and mirror in `electron.vite.config.ts` `resolve.alias` for each of the main / preload / renderer sections (currently only renderer has one).
- Rewrite the 12 relative cross-boundary imports found:
  - `src/preload/index.ts` (`../main/…` ×3)
  - `src/renderer/src/{dia.d.ts, app.tsx, components/pane.tsx, components/pane-tree-view.tsx, components/permission-request-card.tsx, components/clarifying-question-card.tsx, components/pane-creation-form.tsx, components/pulse-indicator.tsx}` (`../../main/…`, `../../../main/…`)
- Verify `pnpm typecheck` + `pnpm build` (main/preload/renderer bundles) resolve the aliases.

## Phase 2 — Clear the LSP diagnostics

Test-file edits invoke `with-testing-principles`; all Effect edits follow `effect-ts`.

- **`floatingEffect` (2 errors)** — `pending-user-input.test.ts:66,67`: bind/`yield*` the `Deferred` values instead of discarding them.
- **`runEffectInsideEffect` (index.ts:117)** — replace nested `Effect.runPromise` with the surrounding runtime (`Effect.runtime` + `Runtime.runPromise`).
- **`unnecessaryFailYieldableError` (8)** — `yield* Effect.fail(taggedError)` → `yield* taggedError` in `git-ops-service.ts` (103,185), `pane-supervisor.ts` (485,497), `pane-workspace.ts` (135,155,167,181).
- **`multipleEffectProvide` (26)** — collapse chained `.pipe(Effect.provide(a), Effect.provide(b))` into one provide of merged layers (`Layer.mergeAll`/combined layer). Concentrated in test setup (`git-ops-service.test.ts`, `pane-supervisor.test.ts`, `persistence.test.ts`, `settings-store.test.ts`) plus `index.ts:123`. Consider a shared test layer to remove the repetition.

## Phase 3 — Effect idiom refactors (audit-driven)

The single highest-value target — `pane-supervisor.ts` `toIpcEvent`/`toAttentionTarget` — appears in all three lenses (null→Option, exhaustive matching, tagged construction). Do it first within this phase.

**3a. Pattern matching (`Match`)**
- `pane-supervisor.ts:107-179` `toIpcEvent`/`toAttentionTarget` `switch(_tag)` → `Match.value(...).pipe(Match.tag(...), Match.exhaustive)`. Removes the silent `default: return null` gap on the growing `OutboundMessage` union.
- `agent-session.ts:73-96` `toPermissionResult` → `Match.tag`/`Match.tags` (`Answers`/`FreeformResponse` share a handler).
- `gateway.ts:129-232` `wireCommands` `switch(_tag)` → `Match.exhaustive`.

**3b. Tagged construction via `.make()`** (stop hand-writing `{ _tag: … }`)
- `preload/index.ts` 7 sites → `SendMessage.make({…})` etc.
- `gateway.ts:112,219-223` → `LayoutChanged.make`, `PaneCreateFailed.make`.
- `pane-supervisor.ts` `toAttentionTarget` + others → `Idle.make`, `Completed.make`, `Errored.make`, `AwaitingPermission.make`, `PermissionRequest.make`.
- `pane-workspace.ts:85,187,216-219` → leaf/`PaneAttentionChanged`/`Errored` constructors.
- Enabler: export `PaneLeafSchema`/`PaneSplitSchema` from `domain/pane-tree.ts` so construction sites (incl. `pane-tree.ts:78,159,187`) can use `.make()`.

**3c. Effect-native data types**
- `logger.ts:17-27` `lineTimestamp` → return `Option<number>` via `Either.try` for the parse; caller consumes with `Option`.
- `pane-supervisor.ts` `toIpcEvent`/`toAttentionTarget` return `Option<…>` (folds into 3a); call sites (~318-322) use `Option.match`/`Option.isSome`.
- `settings-store.ts:42,48` `parsed._tag === 'Left'` → `Either.isLeft` (align to `persistence.ts` idiom).
- `agent-session.ts:153-159` `parseToolInput` raw try/catch → `Either.try(...).pipe(Either.getOrElse(…))`.

**3d. `Effect.fn` adoption** (named spans for reusable Effect functions)
- High: `agent-session.ts` `canUseTool` inner gen (98-130); `logger.ts` `pruneOldLogEntries` (34-54).
- Med: `pane-supervisor.ts` `applyAttention` (232-269); `agent-session.ts` `resolveRequest` (132-138).
- Low: `agent-session.ts` `dropPendingRequests` (140-145); `pending-user-input.ts` `resolve` (59-66).

**3e. Dedup**
- `gateway.ts:129-232` extract a `withHandle(paneId, label, op)` helper for the repeated get-handle/guard/catch shape (folds together with 3a).

## Phase 4 — Verify & document

- `effect-tsgo diagnostics` → target **0 errors**, warnings minimized.
- `pnpm typecheck`, `pnpm test`, `pnpm build` all green.
- Reasoning-log entry (`docs/reasoning/`): native tsgo vs classic language-service patch; `@effect/tsgo` + `effect-tsgo patch`; vendored-repo version pinning gotcha.
- Optional: short ADR for adopting `@effect/tsgo` as the Effect-aware typecheck tool (tooling decision, sibling to ADR-0004).

## Explicitly out of scope

- Renderer Effect adoption (stays plain React per ADR-0002).
- `Ref`/`HashMap` for the single-fiber `Map`s in `agent-session.ts`/`pending-user-input.ts` — audit confirmed no concurrency; would be ceremony.
- 4.0-only Effect APIs.

## Sequencing / risk

0 → 1 → 2 → 3 → 4. Phases 0–2 are low-risk and unlock a clean diagnostic baseline before the larger Phase 3 idiom work. Each phase ends green on typecheck + tests before the next. Commits per phase (conventional-commit messages).
