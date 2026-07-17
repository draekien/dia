# dia

dia is a personal desktop application — a self-built alternative to Claude Desktop — that drives the user's local Claude installation via the Anthropic TypeScript Agent SDK.

## Architecture decisions

All significant architecture and tech-stack decisions are recorded as ADRs in `docs/adr/`, written in MADR format. **Before proposing or changing anything architectural (process model, framework, build tooling, styling, repo layout), read the existing ADRs in `docs/adr/` first** — do not contradict an accepted decision without first surfacing the conflict to the user and, if they agree to change course, writing a new ADR (or superseding the old one).

See `docs/adr/README.md` for the index of current decisions.

When a new significant architecture decision is made during a session, write it up as a new ADR using `docs/adr/template.md`, following the numbering convention (`NNNN-short-title.md`), and add it to the index in `docs/adr/README.md`.

## Reasoning log

`docs/reasoning/` captures non-obvious decisions, gotchas, and learnings from past sessions — smaller-grained than an ADR (a tricky bug's root cause, a library quirk, a rejected approach and why) but still worth not rediscovering the hard way. **Check `docs/REASONING.md` (the index) when starting work in an area that feels tricky or has surprised you before.**

When you hit a genuinely non-obvious finding during a session — something that took real effort to figure out, or that would trip up a future session — write it up as a new entry using `docs/reasoning/template.md`, named `YYYY-MM-DD-short-slug.md`, and add it to the index in `docs/REASONING.md`. Don't log routine implementation notes.

You must not let the reasoning log drift from the current state of the project. Out of sync documentation is worse than no documentation at all.

## Reference docs

- `docs/llms/electron-vite.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the electron-vite guide (build tool chosen in ADR-0004). Consult it before making electron-vite config, dev/HMR, build, or packaging changes.
- `docs/llms/agent-sdk.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the Claude Agent SDK docs (the SDK dia uses to drive Claude, per ADR-0003). **This is the first thing to check for ANY Agent SDK question or task** — sessions, permissions, hooks, MCP, subagents, or the TypeScript/Python API — whether you're answering a question, debugging, or writing code. Read it before reaching for general Claude API knowledge, a skill, or a subagent; it covers sessions, permissions, hooks, MCP, subagents, and links the full TypeScript/Python API reference.

## Design Context

Renderer-specific — see `src/renderer/CLAUDE.md`.

## Coding

- Make sure to set up logs for code you write using Effect's logger methods so its easy to trace and debug issues.
- Do not write inline comments that explain what a piece of code does. Write self-documenting code instead — clear names, small functions, obvious structure — rather than narrating the implementation alongside it.
- Every module export (function, class, const) must have a JSDoc comment. That JSDoc documents the export's purpose and how to consume it — inputs, outputs, preconditions, when to call it — and must not describe implementation detail (how it works internally).

### Effect TS

- Use Effect's `Clock` service (e.g. `Clock.currentTimeMillis`) instead of `Date.now()`/`new Date()` in any Effect code, so behavior can be driven deterministically with `TestClock` in tests.
- Represent durations with Effect's `Duration` module (`Duration.seconds(5)`, `Duration.days(7)`, `Duration.toMillis(...)`) instead of raw millisecond math or ad-hoc string literals.
- Derive types from their schema (`export type X = typeof XSchema.Type`); never hand-declare an interface/type and a parallel schema. For a recursive schema, a plain `type` alias self-references and errors — use `export interface X extends Schema.Schema.Type<typeof XSchema> {}` instead.
- Construct tagged values via the schema's `.make({...})` constructor (it auto-fills `_tag`), never hand-written `{ _tag: ... }` literals. An anonymous `Schema.TaggedStruct` inline in a `Schema.Union` has no `.make` — extract it to a named export first.
- Schemas shared across processes (main/preload/renderer) live in `src/shared` (import via `@shared/*`) and must stay platform-neutral — no Node/DOM/Electron imports. `tsconfig.shared.json` enforces this. See ADR-0013.
- A path alias must be declared in all of: `tsconfig.base.json` (typecheck), every relevant `electron.vite.config.ts` block (main/preload/renderer — build), and `vitest.config.ts` (tests). Type-only imports resolve without the runtime aliases, so a missing one stays hidden until the first value import.
- Effect diagnostics run inside `pnpm typecheck` and standalone via `pnpm diagnostics` (per-project: `diagnostics:{node,web,test}`). Bust stale `.tsbuildinfo` after changing a severity map. See `docs/reasoning/2026-07-17-effect-tsgo-diagnostics-tooling.md`.

### Mandatory skill invocation

These are BLOCKING REQUIREMENTS, not suggestions. Before writing or editing any code matching a trigger below, invoke the listed skill via the Skill tool FIRST — before any other response, plan, or edit for that task. If a task matches more than one trigger, invoke all matching skills before starting. Do not skip a trigger because the change "looks small" or "is just a one-liner."

| Trigger                                                                                                                   | Required skill                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Writing or editing any `.ts`/`.tsx` code that uses Effect (services, layers, schemas, streams, runtimes, or typed errors) | `effect-ts`                                  |
| Creating a new service or module                                                                                          | `engineering-skills:module-design`           |
| Writing or updating any test file                                                                                         | `engineering-skills:with-testing-principles` |

Renderer-specific triggers (UI/UX work, shadcn/ui components) are in `src/renderer/CLAUDE.md`.

If you realize partway through a task that a trigger applies and you skipped the skill, stop, invoke the skill, and reconcile your work against its guidance before continuing.
