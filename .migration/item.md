# item

2026-11-01, transformation engine (legacy `new-york`), `Item` moved from `Slot` to `useRender` + `mergeProps`.

## Changed

* `src/renderer/src/components/ui/item.tsx`: `Item` takes `render` instead of `asChild`; `data-slot`, `data-variant`, `data-size` come from `state`.
* `plugins/agent-overview/remove-project-dialog.tsx:148`: `<Item asChild …><li>…</li></Item>` → `<Item render={<li />} …>…</Item>`.
* Leftover scan: clean.

## Left alone

* `ItemSeparator` composes the separator wrapper (see separator.md).

## Behavior changes

* None.

## Verify by hand

* Remove a project that has agents: the dialog lists each agent as a row with its state icon.
