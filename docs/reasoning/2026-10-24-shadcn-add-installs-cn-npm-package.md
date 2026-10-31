# `shadcn add skeleton` installed an npm package named `cn`

**Date:** 2026-10-24

## Context

`pnpm dlx shadcn@latest add skeleton` was run to add the `Skeleton` component for the startup placeholder (ADR-0027).

## Reasoning / Learning

The CLI wrote `src/renderer/src/components/ui/skeleton.tsx` with `import { cn } from "cn"` instead of the project's `@renderer/lib/utils`, and then ran "Installing dependencies": it added the unrelated npm package `cn` 0.5.0 to `package.json` and `pnpm-lock.yaml`. The cause of the wrong import was not investigated (unverified); `components.json` names `@renderer/lib/utils` as the `utils` alias.

On 2026-10-28 `shadcn add sidebar breadcrumb` (CLI 4.22.1) did the same to `sidebar.tsx`, `sheet.tsx` and `breadcrumb.tsx`, and also appended generic `--sidebar`, `--sidebar-foreground` and related variables to `index.css`, which would override the `--color-sidebar-*` mappings to dia's palette in `@theme inline`.

On 2026-10-31 `shadcn add item` (CLI 4.23.0) did the same to `item.tsx`, and stopped at a prompt to overwrite the existing `separator.tsx`; answering `n` keeps the local file.

## Implication

After every `shadcn add`, run `git diff package.json pnpm-lock.yaml` and read the new file's imports. If an unexpected dependency appeared: `git checkout -- package.json pnpm-lock.yaml`, then `pnpm install --frozen-lockfile` (it prunes the package from `node_modules`), and rewrite the import to `@renderer/lib/utils`. Also add `motion-reduce:animate-none` to `Skeleton`, because the generated class only has `animate-pulse` and `DESIGN.md` requires reduced-motion support.
