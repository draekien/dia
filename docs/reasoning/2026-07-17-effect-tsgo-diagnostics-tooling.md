# Effect diagnostics via `@effect/tsgo` (native tsc)

**Date:** 2026-07-17

## Context

We wanted the Effect language-service diagnostics (excessive nesting, `preferSchemaOverJson`,
`unnecessaryFailYieldableError`, `multipleEffectProvide`, etc.) to run as part of `pnpm typecheck`,
not just interactively in an editor. The classic `@effect/language-service` TS plugin is a
`tsserver` plugin and does not run under a plain `tsc` CLI invocation, so wiring it into a
headless typecheck was the fork in the road.

## Reasoning / Learning

- **`typescript@7` is the native Go compiler (tsgo), and the classic language-service patch does
  not apply to it.** The native path is `@effect/tsgo`: its `prepare` step runs `effect-tsgo patch`,
  which patches the installed `tsc` binary in place (`7.0.2+effect-tsgo.0.22.0`). After patching, a
  normal `tsc --noEmit -p <config>` emits Effect diagnostics — but **only for the files that config
  includes, and only per that config's own plugin severity map.**
- **Severity is per-tsconfig, via `plugins[0].diagnosticSeverity`, and the array REPLACES across
  `extends` — it does not merge.** So a child config that declares its own `diagnosticSeverity` must
  restate every rule it wants, not just the deltas. Rule names are bare (`globalDateInEffect`), no
  `effect/` prefix. Exit-code behavior: `warning`/`error` fail the typecheck; `message`/`suggestion`
  do not.
- **To relax a rule for tests only, prefer a dedicated `tsconfig.test.json` over inline
  suppressions or touching every call site.** Test files legitimately trip `globalDateInEffect`
  (fixture `new Date()`s), `multipleEffectProvide` (layered `Effect.provide` chains where a later
  layer satisfies an earlier one's requirement — parallel `Layer.mergeAll` would not compile there),
  and `preferSchemaOverJson`. A test config that `extends` the base but overrides those three to
  `"off"` in its own `diagnosticSeverity`, and whose `include` is only `*.test.ts(x)` + `*.d.ts`,
  keeps production strict while dropping the 24-site churn. (Miss the `*.d.ts` and ambient globals
  like `Window.dia` vanish under the narrow include.)
- **`.tsbuildinfo` caching masks severity/plugin changes.** After changing a `diagnosticSeverity`
  map or a suppression directive, delete the build info first or the run reports stale results:
  `find . -maxdepth 2 -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete`.
- **Inline escape hatches both exist:** `// @effect-diagnostics <rule>:off` (file-scoped) and
  `// @effect-diagnostics-next-line <rule>:off` (line-scoped). Reserve these for genuine non-Effect
  boundaries (bootstrap `node:` imports, the `DIA_*` cross-process env channel, preload
  `console.warn`, renderer React async handlers) rather than to dodge a real production fix.
- **`effectFnIife` gotcha:** an immediately-invoked `Effect.fn('name')(function*(){…})()` is flagged
  — `Effect.fn` is for *reusable* functions that take arguments. For a single-use named span, use
  `Effect.gen(function*(){…}).pipe(Effect.withSpan('name'))` instead.
- Running the checker directly (outside the typecheck) is wired as `pnpm diagnostics` (all three
  projects) and `pnpm diagnostics:{node,web,test}` (one project, `--format pretty`). Under the hood
  the flag is `--project <tsconfig>` (relative path is fine), not `-p`.

## Implication

`pnpm typecheck` now runs three configs (`tsconfig.node.json`, `tsconfig.web.json`,
`tsconfig.test.json`) and is the single source of truth for Effect diagnostics. When adding a new
diagnostic-severity rule, edit the base map **and** restate it in `tsconfig.test.json` (arrays don't
merge). When a diagnostics change seems not to take effect, suspect `.tsbuildinfo` before the config.
See also [Vendored `.repos/effect` API drift](2026-07-12-effect-vendored-repo-api-drift.md) — the
skill's vendored clone is now pinned to the installed `effect@3.21.4` tag so signatures match.
