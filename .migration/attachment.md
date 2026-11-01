# attachment

2026-11-01, transformation engine (legacy `new-york`), `AttachmentTrigger` moved from `Slot` to `useRender` + `mergeProps`.

## Changed

* `src/renderer/src/components/ui/attachment.tsx`: `AttachmentTrigger` takes `render` instead of `asChild`; `type` defaults to `'button'` only when no `render` is given, as before.
* `plugins/chat/attachment-chips.tsx` renders `AttachmentTrigger` as the dialog trigger (see dialog.md).
* Leftover scan: clean.

## Left alone

* `data-[state=idle|error|…]` classes: they read the component's own `state` prop, not Radix.

## Behavior changes

* None.

## Verify by hand

* Attach an image, then click its chip: the preview dialog opens.
