# breadcrumb

2026-11-01, transformation engine (legacy `new-york`), `BreadcrumbLink` moved from `Slot` to `useRender` + `mergeProps`.

## Changed

* `src/renderer/src/components/ui/breadcrumb.tsx`: `BreadcrumbLink` takes `render` instead of `asChild`, typed `useRender.ComponentProps<'a'>`; `data-slot` comes from `state: { slot: 'breadcrumb-link' }`. The other parts are plain elements and did not change.
* No call site used `BreadcrumbLink asChild`.
* Leftover scan: clean.

## Left alone

* `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbPage`, `BreadcrumbSeparator`, `BreadcrumbEllipsis`: no Radix code.

## Behavior changes

* None.

## Verify by hand

* The tab header crumbs show the project and page names with a chevron between them.
