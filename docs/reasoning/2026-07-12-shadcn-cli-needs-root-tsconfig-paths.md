# shadcn CLI requires path aliases in the root tsconfig.json, not just tsconfig.web.json

**Date:** 2026-07-12

## Context

Adding the `select` and `switch` components via `npx shadcn@latest add` (bullet 03, T6) failed with `Could not resolve the following aliases in F:\Dev\dia: components, ui, lib, hooks, utils`, even though `components.json` and `tsconfig.web.json` both correctly define the `@renderer/*` alias.

## Reasoning / Learning

The repo's root `tsconfig.json` is a solution file (`"files": []`, only `references` to the four project configs). It had no `compilerOptions.paths` of its own, and the shadcn CLI reads the root `tsconfig.json` to resolve `components.json`'s aliases; it did not follow TS project references into `tsconfig.web.json` to find the path mapping. Adding `compilerOptions.paths` for `@renderer/*` to the root `tsconfig.json` fixed it. The root file's `"files": []` makes that addition inert for compilation; it only feeds tooling that reads the root config directly.

Current configuration: the root `tsconfig.json` extends `tsconfig.base.json`, and `@renderer/*` is declared in `tsconfig.base.json`. Whether the shadcn CLI resolves paths through `extends` was not re-verified.

## Implication

- Keep `@renderer/*` in `tsconfig.base.json`, which the root `tsconfig.json` extends and which the shadcn CLI needed to find through the root config.
