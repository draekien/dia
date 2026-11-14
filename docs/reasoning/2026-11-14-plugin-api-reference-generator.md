# @effect/docgen drops the JSDoc of re-exports; typedoc with typedoc-plugin-markdown generates the plugin API reference

**Date:** 2026-11-14

## Context

Issue #168 ships `references/api.md`, a markdown list of every export of `src/host/plugin-api.ts` (`@dia/plugin`) with its JSDoc, generated at build time. The issue chose `@effect/docgen` and named typedoc plus a JSON-to-markdown script as the fallback. Both tools need TypeScript below 7 (`@effect/docgen` 4.1.4 peer `typescript >=5.8.2 <7.0.0`; typedoc 0.28.20 supports up to 6.0); the repo uses 7.0.2, so both run through `pnpm dlx` with `typescript@6.0.3`.

## Reasoning / Learning

- `plugin-api.ts` consists only of re-exports. `@effect/docgen` 4.1.4 documents a re-export as a declaration in `plugin-api.ts`: 0 of its 81 entries carried JSDoc, and the three `export * from` lines were listed as single entries with no members.
- Run without the worktree's `node_modules` installed, both tools printed every symbol from `effect` as `any` (docgen) or failed with `TS2307: Cannot find module 'effect'` (typedoc). Run `pnpm install` in a fresh worktree before generating.
- typedoc 0.28.20 follows re-exports to their declarations: 166 of 167 exports carried JSDoc; the one without, `AgentEvents`, is an `export * as` namespace whose members carry their own.
- typedoc-plugin-markdown 4.14.1 renders typedoc's model as markdown, so no JSON-to-markdown script is needed. It has no single-file output: with `--router module` it writes the module page to `README.md` and each namespace to `<package>/namespaces/<Name>.md`. `scripts/plugin-api-reference.ts` merges those pages into one file and rewrites the one link from the module page to the namespace page.
- `--disableSources` removes the `Defined in: <path>:<line>` lines. With them, moving code without changing the API would change the file, and the meta plugin would commit a new `references/api.md` to the meta repo.

## Implication

Generate the reference with `pnpm build:plugin-api-reference` (`scripts/generate-plugin-api-reference.ts`), which `pnpm build` runs first. Do not switch to `@effect/docgen` while `@dia/plugin` is a module of re-exports.
