# tooltip

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/tooltip` with the Portal > Positioner > Popup model.

## Changed

* `src/renderer/src/components/ui/tooltip.tsx`: `TooltipProvider` default `delayDuration = 0` → `delay = 0`; `TooltipContent` exposes `side`/`sideOffset`/`align`/`alignOffset` and forwards all four to `Positioner` (`isolate z-50`); Popup keeps the user's classes with `origin-(--radix-tooltip-content-transform-origin)` → `origin-(--transform-origin)` and `data-[state=closed]:*` → `data-closed:*`. `sideOffset` default 0 → 4: Radix added the arrow's height to the offset itself, Base UI does not. The Arrow gets per-side positioning classes from the base-nova golden.
* `src/renderer/src/main.tsx:32`: `<TooltipProvider delayDuration={400}>` → `delay={400}`.
* `TooltipTrigger asChild` → `render` at 9 sites: `model-field.tsx`, `session-rail.tsx`, `claude-code-settings.tsx`, `ui/sidebar.tsx`, `agent-overview.tsx`, `context-card.tsx`, `pane.tsx` (3), `queued-messages.tsx`.
* `plugins/agent-overview/agent-overview.test.tsx`: "shows the same text as a tooltip when a dot is focused" finds the popup by `[data-slot="tooltip-content"]` instead of `role="tooltip"`. Proved falsifiable by flipping the expected text.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* Base UI renders no `role="tooltip"` and adds no `aria-describedby` to the trigger. Radix did both, so screen readers announced the tooltip text as the trigger's description. Every trigger in this repo also has an `aria-label` or visible text, but text that exists only in a tooltip (for example "Available when this turn ends" on Compact conversation) is no longer announced. Flagged; not patched.
* `disableHoverableContent` has no equivalent (Base UI's is `disableHoverablePopup` on Root). No call site used it.

## Verify by hand

* Hover the composer's send button: the tooltip appears after about 400ms, above the button, with its arrow pointing at it.
* Collapse the sidebar and focus an agent dot with Tab: its tooltip appears on the right.
* Move the pointer from one toolbar button to the next: the second tooltip opens without the delay.
