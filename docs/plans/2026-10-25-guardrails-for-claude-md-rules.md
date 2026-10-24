# Plan: checks for rules CLAUDE.md states only as prose

Status: **proposed**
Date: 2026-10-25
Driven by: an agent-docs audit (2026-10-25). Each rule below can be decided from the code, is broken by accident, and nothing in the repository fails when it is broken (`biome.json` has no plugins; `lefthook.yml` runs only `pnpm typecheck` and `pnpm lint:fix`).

## Candidates

| Rule (`CLAUDE.md`) | Mechanism | Where the check lives | What the prose becomes |
| --- | --- | --- | --- |
| Every module export has a JSDoc comment | Linter rule (a Biome GritQL plugin) that flags an `export` declaration with no preceding `/** */` | `biome.json` `plugins` | Keep only the part a linter cannot check: JSDoc documents purpose and use, not implementation |
| Use `Clock` instead of `Date.now()`/`new Date()` in Effect code | Linter rule banning `Date.now()` and `new Date()` under `src/host`, `src/shared` and `plugins` | `biome.json` `plugins`, scoped by path | Delete; the lint message names `Clock.currentTimeMillis` |
| Construct tagged values with `.make`, never `{ _tag: ... }` literals | Linter rule flagging an object literal with a `_tag` property outside schema definitions | `biome.json` `plugins` | Keep the remedy for anonymous `Schema.TaggedStruct` members (extract to a named export) |
| Bump `PROTOCOL_VERSION` whenever `DiaRpcs` changes shape | Test: a snapshot of the encoded `DiaRpcs` schema stored next to the `PROTOCOL_VERSION` it was taken at; a changed snapshot with an unchanged version fails | a new `src/shared/ipc/rpc.test.ts` | Delete; the test failure states the rule |
| A path alias is declared in `tsconfig.base.json`, every relevant `electron.vite.config.ts` block, and `vitest.config.ts` | Test that reads the three configs and compares alias names per target | a test beside `vitest.config.ts` | Keep the reason (type-only imports resolve without runtime aliases) |
| An RPC wrapper field does not reuse a command payload field name | Test over `DiaRpcs` asserting wrapper and payload field names are disjoint | a new `src/shared/ipc/rpc.test.ts` | Delete the first sentence; keep the requirement for a pass-through test |

## Out of scope

Rules that need judgement stay as prose: logging coverage, inline comments versus public API docs, `Effect.gen` versus pipe nesting, and deriving types from schemas.
