# Base UI wrappers: four changes that typecheck but behave differently from Radix

**Date:** 2026-11-01

## Context

The shadcn/ui wrappers in `src/renderer/src/components/ui/` moved from Radix to Base UI (`@base-ui/react` 1.9.0, see [ADR-0049](../adr/0049-base-ui-primitives-under-shadcn-ui.md)). Each of the four changes below passed `pnpm typecheck` and broke behaviour that only a test or the running app showed.

## Reasoning / Learning

1. **`SelectValue` shows the raw value.** With no children, Base UI's `Select.Value` renders the selected `value` (`resolveSelectedLabel` in `internals/resolveValueLabel.js` falls back to the value when the root has no `items`). Radix copied the selected item's text. `<SelectValue />` over model ids shows `claude-opus-5-5`, not `Opus 5.5`. Every select in this repo passes the label as children, for example `<SelectValue>{thinkingLevelLabel(level)}</SelectValue>`. An empty string counts as a selected value, so pass `null`, not `''`, to show the `placeholder`.
2. **A control's `id` must not contain whitespace.** Checkbox, radio and switch render a `<span role="…">` plus a hidden `<input>` that receives the `id`. Base UI names the span with `aria-labelledby="<id>-label"`, which it assigns to the associated `<label>`. `aria-labelledby` is a space-separated id list, so `id="Which scope?-Small"` points at two ids that do not exist and the control has no accessible name. Radix put the `id` on a `<button>`, where `<label htmlFor>` matched it whatever it contained. `plugins/dia-chat/clarifying-question-card.tsx` builds ids from `useId()` and indexes for this reason.
3. **Menu items fire `onClick`, not `onSelect`.** Radix menu items called `onSelect` when chosen. On a Base UI item, `onSelect` is the DOM text-selection event, which TypeScript accepts as a valid prop, so the handler never runs on click or Enter. Use `onClick`; Base UI fires it for pointer and keyboard activation.
4. **The select `List` must be the scroll container.** With `alignItemWithTrigger` off, Base UI measures the `List` to decide whether to show `ScrollUpArrow` and `ScrollDownArrow` (`handleScrollArrowVisibility(listElement || popupElement)` in `select/popup/SelectPopup.js`), but it applies the `List` scroll styles only when `alignItemWithTrigger` is on (`LIST_FUNCTIONAL_STYLES` in `select/list/SelectList.js`). With `overflow-y-auto` on the `Popup`, as in shadcn's `base-nova` select, a long list shows the native scrollbar and never shows the arrows. `SelectContent` makes the `Popup` `flex flex-col overflow-hidden` and gives the `List` `min-h-0 overflow-y-auto`; Base UI then hides the `List` scrollbar and shows the arrows.

## Implication

When a wrapper or call site moves from Radix to Base UI, check these four points by hand; the type checker reports none of them. Tests that query by role and accessible name (`getByRole('radio', { name })`) catch the second.
