# project

2026-11-01, whole-project migration, transformation engine on the user's own files (style `new-york` is legacy: base-nova goldens used only as a structural reference). All 21 Radix wrappers now run on `@base-ui/react` 1.9.0; `radix-ui` is removed.

## Dependency swap

| Package | Before | After |
|---|---|---|
| `radix-ui` | 1.8.1 | removed (`pnpm remove radix-ui`) |
| `@base-ui/react` | — | 1.9.0 (pinned, `pnpm add -E`) |

`@radix-ui/react-dialog@1.3.1` and its `@radix-ui/*` dependencies stay in `pnpm-lock.yaml`: `cmdk@1.1.1` depends on them (`pnpm why @radix-ui/react-dialog`).

`PLUGIN_API_VERSION` (`src/shared/plugin/manifest.ts`) and every `plugins/*/plugin.json` `api` went from `0.0.16` to `0.0.17`, because `@dia/renderer-plugin` re-exports these wrappers and their props changed.

## App-code sweep

| Change | Call sites |
|---|---|
| `asChild` → `render` | 22 (tooltip 9, popover 3, dialog 1, alert-dialog 2, context-menu 2, sidebar 3, item 1, bubble 1) |
| `TooltipProvider delayDuration` → `delay` | `src/renderer/src/main.tsx` |
| `ToggleGroup type="single"` removed; `value` wrapped in an array | `general-settings.tsx` (3), `transcript-width-toggle.tsx` |
| `Select onValueChange` guarded against `null` | 9 |
| bare `<SelectValue />` given its label as children | 4 |
| `ContextMenuItem onSelect` → `onClick` | 7 |
| control ids rebuilt without whitespace | `plugins/chat/clarifying-question-card.tsx` |

Leftover scan: `grep -rn "radix-ui\|@radix-ui"` over `src/` and `plugins/` returns nothing. `grep -rn "asChild"` over `src/` and `plugins/` returns nothing.

## Docs

* `docs/adr/0049-base-ui-primitives-under-shadcn-ui.md` (extends ADR-0005), indexed in `docs/adr/README.md`.
* `docs/reasoning/2026-11-01-base-ui-wrapper-traps.md`, indexed in `docs/REASONING.md`.
* `docs/designs/settings-dialog-and-inset-sidebar.md:150`: `SidebarGroupLabel asChild` wording updated to `render`.

## Final build vs baseline

| Check | Baseline (a424db1) | Final |
|---|---|---|
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test` | exit 0, 1895 tests | exit 0, 1895 tests |
| `pnpm build` | exit 0 | exit 0 |
| `pnpm lint` | exit 0 | exit 0, 1 warning in `plugins/chat/use-composer-attachments.ts:10` (unused import; that file is untouched on this branch) |

## Flagged, not fixed

* `components.json` still says `"style": "new-york"`. shadcn publishes no `base-new-york`, so `shadcn add` keeps delivering Radix variants for this style. Either convert future components by hand or move to a `base-*` style, which would restyle the app.
* No check in the running app was done. Positioning, animations and focus return are only verified by unit tests in jsdom. See each component's "Verify by hand".
