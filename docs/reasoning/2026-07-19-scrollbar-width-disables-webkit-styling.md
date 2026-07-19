# Standard `scrollbar-width` disables `::-webkit-scrollbar` in Chromium

**Date:** 2026-07-19

## Context

The message-scroller (and, earlier, the `/` command popover) rendered a plain
native scrollbar — white track, arrow buttons — no matter how the thumb was
styled. Several attempts to draw a shadcn-`ScrollArea`-style pill via a custom
`@utility` with `::-webkit-scrollbar` rules had *zero* visible effect: the
compiled CSS was correct, the class was on the scrolling element, yet the native
bar rendered every time. It looked like "native scroll, just thinner."

## Reasoning / Learning

**Chromium ignores every `::-webkit-scrollbar` pseudo-element rule on any element
that also carries the standard `scrollbar-width` (or `scrollbar-color`)
property.** The two styling systems are mutually exclusive per-element: set the
standard property and you get the OS-drawn thin/none bar (colorable but never
rounded or inset); omit it and Chromium honors the legacy `::-webkit-scrollbar`
pseudo-elements (which *can* do radius, inset, hover, etc.).

The trap was a **name collision**. `shadcn/tailwind.css` (added via
`@import 'shadcn/tailwind.css'`) ships a scrollbar plugin that defines
`scrollbar-thin` → `scrollbar-width: thin`, plus `scrollbar-thumb-*` /
`scrollbar-track-*` → `scrollbar-color`. The project *also* had a custom
`@utility scrollbar-thin` with `::-webkit-scrollbar` rules. Same class name, so
both landed on the viewport: the standard `scrollbar-width: thin` won the actual
rendering and silently suppressed the webkit pill. Redefining or even deleting
the custom `@utility scrollbar-thin` changed nothing, because the shadcn version
was always the one in control — which is exactly the confusing symptom ("I
removed it and nothing changed").

Ruled out along the way: wrong-scroll-element theories (the bar really was the
viewport), stale build, cascade/layer ordering. The compiled CSS told the story —
grepping the output for `scrollbar-width` surfaced the competing `.scrollbar-thin
{ scrollbar-width: thin }` rule.

Fix: give the custom webkit scrollbar a name the shadcn plugin doesn't own
(`scrollbar-app`), styled purely via `::-webkit-scrollbar` (8px `--border` pill,
inset 1px via a transparent border + `background-clip: padding-box`,
`scrollbar-gutter: stable`, hidden during autoscroll with
`&[data-autoscrolling]::-webkit-scrollbar { display: none }`). Because that class
sets no standard `scrollbar-width`, Chromium applies the pill. The shadcn
scrollbar utilities can *never* reproduce a rounded inset pill — they only expose
width + color — so a native-scroll element that must match `ScrollArea` has to
use the webkit route.

## Implication

- To style a native scrollbar as anything richer than "thin + tinted" (radius,
  inset, hover), the element must use `::-webkit-scrollbar` and carry **no**
  standard `scrollbar-width`/`scrollbar-color`. Don't mix the two systems on one
  element.
- Never name a custom scrollbar `@utility` `scrollbar-thin`/`scrollbar-none`/
  `scrollbar-{thumb,track}-*` — those collide with `shadcn/tailwind.css` and the
  standard-property version wins. Use a distinct name (`scrollbar-app`).
- When scrollbar styling "does nothing," grep the *compiled* CSS for
  `scrollbar-width` — a stray standard property is the tell.
- A true floating overlay (Radix `ScrollArea`) still can't be transplanted onto
  the message-scroller viewport: the primitive owns that scroll element (writes
  `scrollTop`, toggles `data-autoscrolling`). The webkit pill is the match.
