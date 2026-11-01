# bubble

2026-11-01, transformation engine (legacy `new-york`), `BubbleContent` moved from `Slot` to `useRender` + `mergeProps`.

## Changed

* `src/renderer/src/components/ui/bubble.tsx`: `BubbleContent` takes `render` instead of `asChild`; `data-slot` comes from `state: { slot: 'bubble-content' }`.
* `plugins/chat/queued-messages.tsx:264`: `<BubbleContent asChild><button …><BubbleBody/></button></BubbleContent>` → `<BubbleContent render={<button … />}><BubbleBody/></BubbleContent>`.
* Leftover scan: clean.

## Left alone

* `Bubble`, `BubbleGroup`, `BubbleReactions`: plain elements.

## Behavior changes

* None.

## Verify by hand

* Queue two messages while a turn runs, dismiss the queue, then click the collapsed front bubble: the queue reopens.
