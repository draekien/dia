# button

2026-11-01, transformation engine (legacy `new-york`), migrated to the `@base-ui/react/button` primitive.

## Changed

* `src/renderer/src/components/ui/button.tsx`: `Slot.Root`/`'button'` switch replaced by `ButtonPrimitive`; props typed `ButtonPrimitive.Props & VariantProps<typeof buttonVariants>`; `asChild` removed (Base UI's `render` prop replaces it). `buttonVariants` classes unchanged.
* No call site used `<Button asChild>`.
* Leftover scan `grep -n "radix-ui\|@radix-ui" button.tsx`: clean.

## Left alone

* `buttonVariants` class strings: kept byte for byte; the base-nova golden restyles them.

## Behavior changes

* To render a non-`<button>` element through `render`, also pass `nativeButton={false}`; Base UI otherwise warns and applies native-button semantics.

## Verify by hand

* Tab to a button and press Enter and Space: both activate it.
* A disabled button shows 50% opacity and ignores clicks.
