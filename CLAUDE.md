# dia

dia is a personal desktop application — a self-built alternative to Claude Desktop — that drives the user's local Claude installation via the Anthropic TypeScript Agent SDK.

@AGENTS.md

## Architecture decisions

**Before proposing or changing anything architectural (process model, framework, build tooling, styling, repo layout), read the ADRs in `docs/adr/`** (index: `docs/adr/README.md`). Do not contradict an accepted ADR without first raising the conflict with the user; if they agree to change course, write a new ADR or supersede the old one.

Record each new significant architecture decision as an ADR from `docs/adr/template.md`, named `NNNN-short-title.md`, and add it to the index.

## Reasoning log

`docs/reasoning/` holds non-obvious findings smaller than an ADR: a bug's root cause, a library quirk, a rejected approach and why. **Check the index `docs/REASONING.md` before starting work in an area that has caused problems before.**

Record a finding that took real effort to establish, or that a future session would otherwise get wrong, as a new entry from `docs/reasoning/template.md`, named `YYYY-MM-DD-short-slug.md`, and add it to the index. Do not record routine implementation notes.

Keep every entry consistent with the current code. An out-of-date entry is worse than no entry.

## Writing agent docs

`CLAUDE.md`, `AGENTS.md`, `src/renderer/CLAUDE.md` and `docs/**` state each rule literally (no metaphor, simile or idiom), once, in the most specific document it applies to. Do not restate what `package.json` or a config file already says.

## Reference docs

- `docs/llms/electron-vite.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the electron-vite guide (build tool chosen in ADR-0004). Consult it before making electron-vite config, dev/HMR, build, or packaging changes.
- `docs/llms/agent-sdk.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the Claude Agent SDK docs, linking the full TypeScript/Python API reference. **Read it first for any Agent SDK question or task** (sessions, permissions, hooks, MCP, subagents), whether answering, debugging or writing code, before general Claude API knowledge, a skill, or a subagent.

## Coding

- Add logging with Effect's logger methods to code you write, so its behaviour can be traced and debugged.
- Do not write inline comments that explain what code does; use clear names, small functions and obvious structure instead.
- Every module export (function, class, const) must have a JSDoc comment. That JSDoc documents the export's purpose and how to consume it — inputs, outputs, preconditions, when to call it — and must not describe implementation detail (how it works internally).

### Effect TS

This repository uses Effect v4. Before writing any Effect code, first read `node_modules/effect/AGENTS.md` **completely**, and follow the links in the file when required. For APIs the guide does not cover, search `node_modules/effect/src`.

- Use Effect's `Clock` service (e.g. `Clock.currentTimeMillis`) instead of `Date.now()`/`new Date()` in any Effect code, so behavior can be driven deterministically with `TestClock` in tests.
- Represent durations with Effect's `Duration` module (`Duration.seconds(5)`, `Duration.days(7)`, `Duration.toMillis(...)`) instead of raw millisecond math or ad-hoc string literals.
- Derive types from their schema (`export type X = typeof XSchema.Type`); never hand-declare an interface/type and a parallel schema. For a recursive schema, a plain `type` alias self-references and errors — use `export interface X extends Schema.Schema.Type<typeof XSchema> {}` instead, and annotate the recursive schema constant and its `Schema.suspend` thunk as `Schema.Codec<X>`, not `Schema.Schema<X>`: in v4 `Schema.Schema<X>` carries no encoding, so `Schema.encodeSync` on any schema containing it fails to type-check.
- Construct tagged values via the schema's `.make({...})` constructor (it auto-fills `_tag`), never hand-written `{ _tag: ... }` literals. An anonymous `Schema.TaggedStruct` inline in a `Schema.Union` has no `.make` — extract it to a named export first.
- Schemas shared across processes (main/preload/renderer) live in `src/shared` (import via `@shared/*`) and must stay platform-neutral — no Node/DOM/Electron imports. `tsconfig.shared.json` enforces this. See ADR-0013.
- A path alias must be declared in all of: `tsconfig.base.json` (typecheck), every relevant `electron.vite.config.ts` block (main/preload/renderer — build), and `vitest.config.ts` (tests). Type-only imports resolve without the runtime aliases, so a missing runtime alias produces no error until the first value import.
- Effect diagnostics run inside `pnpm typecheck` and standalone via `pnpm diagnostics`. Bust stale `.tsbuildinfo` after changing a severity map. See `docs/reasoning/2026-07-17-effect-tsgo-diagnostics-tooling.md`.
- Avoid excessive nesting from chained `.pipe`/`Effect.andThen` callbacks (see [effect.website/docs/code-style/do](https://effect.website/docs/code-style/do/)). Prefer `Effect.gen` for sequential logic. Reach for the Do-simulation (`Effect.Do`/`Effect.bind`/`Effect.let`) only where `Effect.gen` doesn't fit.

- An RPC wrapper field must not reuse a name a command payload already has. Add a test that the payload's own field reaches the handler unchanged. Bump `PROTOCOL_VERSION` in `src/shared/ipc/rpc.ts` whenever `DiaRpcs` changes shape.
- `pnpm typecheck` exits 1 on Effect *warning* diagnostics (suggestions exit 0). Check its exit code, not `grep "error TS"`: lefthook's pre-commit runs it. Example: `unknownInEffectCatch` on `Effect.try({ catch: (cause) => cause })`; return a `Data.TaggedError` instead.
- A shipped plugin cannot import `src/` (the installer packages only `out/**` and `plugins/**`). It imports host runtime values from `@dia/plugin`: `tsconfig.node.json`, `tsconfig.test.json` and `vitest.config.ts` map it to `src/host/plugin-api.ts`; at runtime the loader's resolve hook maps it to `out/main/plugin-api.js`. Export a new host value from `plugin-api.ts`. vitest never runs that hook; `plugin-modules.test.ts` covers it through a child Node process.

### Mandatory skill invocation

Before writing or editing any code matching a trigger below, invoke the listed skill via the Skill tool FIRST — before any other response, plan, or edit for that task. If a task matches more than one trigger, invoke all matching skills before starting. Do not skip a trigger because the change "looks small" or "is just a one-liner."

| Trigger                                                                                                                   | Required skill                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Writing or editing any `.ts`/`.tsx` code that uses Effect (services, layers, schemas, streams, runtimes, or typed errors) | `effect-ts`                                  |
| Creating a new service or module                                                                                          | `module-design`           |
| Writing or updating any test file                                                                                         | `testing-principles` |

Renderer-specific triggers (UI/UX work, shadcn/ui components) are in `src/renderer/CLAUDE.md`.

If you realize partway through a task that a trigger applies and you skipped the skill, stop, invoke the skill, and reconcile your work against its guidance before continuing.

## Workflow

- Run a task from request to open PR with `/implement-task`.
- Raise every PR through the `raise-pr` skill. Launch and drive the app for a manual check through the `verify-in-app` skill.
