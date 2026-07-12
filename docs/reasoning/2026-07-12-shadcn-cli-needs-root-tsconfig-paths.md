# shadcn CLI requires path aliases in the root tsconfig.json, not just tsconfig.web.json

**Date:** 2026-07-12

## Context

Adding the `select` and `switch` components via `npx shadcn@latest add` (bullet 03, T6) failed with `Could not resolve the following aliases in F:\Dev\dia: components, ui, lib, hooks, utils`, even though `components.json` and `tsconfig.web.json` both correctly define the `@renderer/*` alias.

## Reasoning / Learning

The repo's root `tsconfig.json` is a solution file (`"files": []`, only `references` to `tsconfig.node.json`/`tsconfig.web.json`) with no `compilerOptions.paths` of its own. The shadcn CLI reads the root `tsconfig.json` directly to resolve `components.json`'s aliases — it does not follow TS project references into `tsconfig.web.json` to find the actual path mapping. Adding `compilerOptions.paths` for `@renderer/*` to the root `tsconfig.json` (duplicating what's in `tsconfig.web.json`) fixed it; the root file's `"files": []` means this addition is inert for compilation itself; it only feeds tooling that reads the root config directly.

Separately, `pnpm add`/`shadcn add` (which shells out to `pnpm add`) failed on this machine with `. prepare: '.' is not recognized as an internal or external command` — pnpm's `prepare` lifecycle script (`./scripts/prepare-effect.sh`, a POSIX shell script) doesn't run under the Windows shell pnpm invokes it with. Since `.repos/effect/.git` already existed (the script's actual job is a one-time idempotent clone), `pnpm add <pkg> --ignore-scripts` was safe to use as a workaround for that one install.

## Implication

- Keep root `tsconfig.json`'s `paths` in sync with `tsconfig.web.json`'s `@renderer/*` mapping — it's now load-bearing for the shadcn CLI, not just decorative.
- If a `pnpm add`/`pnpm install` fails with a `prepare` script error mentioning `'.' is not recognized`, that's this repo's `prepare-effect.sh` failing under Windows' default shell, not a dependency problem — retry with `--ignore-scripts` (safe since the script only clones `.repos/effect` once, idempotently).
