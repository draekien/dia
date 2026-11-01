# context-menu

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/context-menu` with the Portal > Positioner > Popup model.

## Changed

* `src/renderer/src/components/ui/context-menu.tsx`: `Sub` → `SubmenuRoot`, `SubTrigger` → `SubmenuTrigger` (open styling `data-[state=open]:*` → `data-popup-open:*`), `Label` → `GroupLabel`, `ItemIndicator` → `CheckboxItemIndicator` / `RadioItemIndicator`. `ContextMenuContent` gains `align='start'`, `alignOffset=4`, `side='right'`, `sideOffset=0` (base-nova golden), forwarded to `Positioner` (`isolate z-50 outline-none`); `--radix-context-menu-content-*` vars → `--available-height` / `--transform-origin`. `ContextMenuSubContent` now composes `ContextMenuContent` with the submenu defaults.
* `plugins/agent-overview/agent-row.tsx` (5 items) and `plugins/agent-overview/project-group.tsx` (3 items): `ContextMenuItem onSelect=` → `onClick=`. TypeScript accepts `onSelect` on a Base UI item because it is the DOM text-selection event, so these would have compiled and never fired.
* `ContextMenuTrigger asChild` → `render` in the same two files.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* `ContextMenuCheckboxItem` / `ContextMenuRadioItem` default to `closeOnClick={false}` in Base UI; Radix closed the menu. No call site uses them.
* `ContextMenu` Root no longer accepts `modal`, and `ContextMenuTrigger` no longer accepts `disabled`. No call site used them.

## Verify by hand

* Right-click an agent row: the menu opens at the pointer; arrow keys move through Show, Rename, Archive, Delete; Enter runs the focused item and closes the menu.
* Right-click a project header: New agent and Reveal in Explorer work, and so does the destructive item below the separator; Escape closes the menu and focus returns to the header.
* Rename from the menu: the inline rename field gets focus.
