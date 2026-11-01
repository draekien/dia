# popover

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/popover` with the Portal > Positioner > Popup model.

## Changed

* `src/renderer/src/components/ui/popover.tsx`: `PopoverContent` exposes `align` (default `'center'`), `alignOffset`, `side` (default `'bottom'`), `sideOffset` (default 4) and forwards all four to `Positioner` (`isolate z-50`); Popup keeps the user's classes with `--radix-popover-content-transform-origin` → `--transform-origin` and `data-[state=…]` → `data-open` / `data-closed`.
* `PopoverTrigger asChild` → `render` at 3 sites: `session-rail.tsx`, `tab-header.tsx`, `plugins/agent-overview/filter-popover.tsx`.
* Leftover scan: clean.

## Left alone

* `PopoverTitle` and `PopoverDescription` stay plain `<div>` / `<p>` as in the user's file, not Base UI's `Popover.Title` / `Description`.

## Behavior changes

* `PopoverAnchor` has no Base UI part. It is now an inert `<div data-slot="popover-anchor">` and does not position anything. No call site used it.
* `openDelay` / `closeDelay` would move from Root to Trigger. No call site used them.

## Verify by hand

* Tab header → ruler button: the Transcript width popover opens below, right-aligned; Escape closes it and focus returns to the button.
* Sidebar filter button: the popover opens, checkboxes toggle, clicking outside closes it.
