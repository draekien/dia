# separator

2026-11-01, transformation engine (legacy `new-york`), migrated to the callable `@base-ui/react/separator`.

## Changed

* `src/renderer/src/components/ui/separator.tsx`: `SeparatorPrimitive.Root` → `SeparatorPrimitive`; `decorative` prop dropped (Base UI has none). Base UI still emits `data-orientation`, so the `data-[orientation=…]` classes are unchanged.
* No call site passed `decorative`.
* Leftover scan: clean.

## Left alone

* `ItemSeparator` and `SidebarSeparator` compose this wrapper and needed no change.

## Behavior changes

* Radix defaulted `decorative` to `true`, which rendered `role="none"`. Base UI always renders `role="separator"` with `aria-orientation`, so screen readers now announce separators.

## Verify by hand

* The collapsed sidebar shows a 1px line before each project's dots.
