# marker

2026-11-01, transformation engine (legacy `new-york`), `Marker` moved from `Slot` to `useRender` + `mergeProps`.

## Changed

* `src/renderer/src/components/ui/marker.tsx`: `Marker` takes `render` instead of `asChild`, typed `useRender.ComponentProps<'div'> & VariantProps<typeof markerVariants>`; `data-slot` and `data-variant` come from `state: { slot: 'marker', variant }`.
* No call site used `Marker asChild`.
* Leftover scan: clean.

## Left alone

* `MarkerIcon`, `MarkerContent`: plain elements.

## Behavior changes

* None.

## Verify by hand

* A transcript system note (for example a compaction marker) shows its separator lines on both sides.
