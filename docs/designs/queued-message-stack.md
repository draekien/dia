# Queued message stack

Issue #92, part of the composer redesign #81. The visual rules are in `DESIGN.md` > Components > Composer > Queued messages. The queue itself is specified in `docs/designs/message-queue-and-steer.md`.

## Component

`QueuedMessages` (`plugins/chat/queued-messages.tsx`) renders above the composer's `InputGroup` in `plugins/chat/pane.tsx`.

| Prop | Source in `PaneChat` |
|---|---|
| `queued`, `held` | `chat.queued`, `chat.queueHeld` |
| `onSendNow(id)` | `paneSendQueuedNowAtom(paneId)`, which calls `window.dia.sendQueuedMessageNow` (#91) |
| `onEdit(id, text)` | `paneEditQueuedAtom(paneId)` |
| `onRemove(id)` | `paneRemoveQueuedAtom(paneId)` |

```text
<section aria-label="Queued messages">         pointer or focus opens; Escape closes
  QueueMarker                                  [ListPlus] 20 queued  send in order when this turn ends
  collapsed stack, height 32 + 22/34/40px
    depth 3  bottom 40px   outline at 55%      aria-hidden
    depth 2  bottom 34px   outline at 55%      aria-hidden
    depth 1  bottom 22px   text at 70%         aria-hidden
    depth 0  bottom 0      newest message: <button "Show 20 queued messages" aria-expanded>
  open overlay, absolute bottom 0, opaque
    QueueMarker
    <ol "20 queued messages, in send order">   max 250px, scrolls, faded top edge
      row: [Send now][Edit][Remove]  dashed one-line bubble
```

- **Open state:** `(hovered || focused || editing) && !dismissed`. Escape sets `dismissed` and moves focus to the front bubble; `dismissed` clears once both the pointer and focus have left the section. An Escape already handled by the editor (`defaultPrevented`) leaves the list open.
- **Layers:** the `stackLayer` cva maps `depth` 0 to 3 to the offset, z-order and colour strength. Bubbles use `Bubble variant="outline"` (opaque `bg-background`) with a dashed border.
- **Row actions:** icon buttons with `aria-label` and a tooltip: `Send now` (tooltip `Send now and steer this turn`, or `Send now` for a held queue), `Edit`, `Remove`. They are hidden until the row is hovered or holds focus.
- **Motion:** the overlay fades in under `motion-safe` only; it closes without a transition.

## Decisions

| Decision | Reason |
|---|---|
| The front bubble is the focus target | The collapsed stack needs one keyboard stop that opens it; the front bubble is the message the user is most likely to act on. |
| The overlay is absolute over the collapsed stack | The transcript does not move when the stack opens, as #92 requires. |
| The attachment row and its `+N` count are not built here | `OutgoingMessage` had no attachments before #74. #74 adds them: the front bubble grows to 54px with up to four chips and `+N`. |
