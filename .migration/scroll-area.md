# scroll-area

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/scroll-area`.

## Changed

* `src/renderer/src/components/ui/scroll-area.tsx`: `ScrollAreaScrollbar` → `Scrollbar`, `ScrollAreaThumb` → `Thumb`; props typed `ScrollAreaPrimitive.Root.Props` / `Scrollbar.Props`. Classes unchanged.
* Leftover scan: clean.

## Left alone

* `plugins/chat/path-menu.tsx:49` and `plugins/chat/slash-command-menu.tsx:53` keep `[&>[data-slot=scroll-area-viewport]>div]:block!`. It overrode the `display: table` on Radix's inner wrapper div. Base UI's viewport has no such div, so the selector now matches the listbox div, which is already `block`. The class is dead but harmless.

## Behavior changes

* No `type` prop (`always` / `scroll` / `hover`). No call site passed one.

## Verify by hand

* Type `@` in the composer in a large project: the path menu caps at 16rem high, scrolls, and the highlighted entry stays in view while pressing the arrow keys.
* Type `/`: the slash command menu does the same.
