# toggle

2026-11-01, transformation engine (legacy `new-york`), migrated to the callable `@base-ui/react/toggle`.

## Changed

* `src/renderer/src/components/ui/toggle.tsx`: `TogglePrimitive.Root` → `TogglePrimitive`; `data-[state=on]:bg-accent data-[state=on]:text-accent-foreground` → `data-pressed:bg-accent data-pressed:text-accent-foreground`.
* No app code renders `<Toggle>` directly; `toggleVariants` is used by toggle-group.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* `onPressedChange` receives `(pressed, eventDetails)`.

## Verify by hand

* Pressed toggles in Settings → General show the accent background.
