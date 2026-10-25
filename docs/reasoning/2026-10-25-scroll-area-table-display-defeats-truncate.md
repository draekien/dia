# Radix ScrollArea content grows to its widest row, so `truncate` inside it does nothing

**Date:** 2026-10-25

## Context

In the packaged app, an agent row whose second line was a long permission reason (`Allow Write C:\Users\...\hello.txt?`) was cut off at the sidebar edge instead of ending in an ellipsis, and the Meta group's "No open proposals" moved out of view. The rows use `truncate` inside `min-w-0` flex children, and they truncated correctly in tests.

## Reasoning / Learning

The Radix `ScrollArea.Viewport` wraps its children in a `div` with an inline `display: table; min-width: 100%`, which lets horizontal scrolling work. A table-display element grows to its widest content, so the list became as wide as the longest unbroken line. Every `truncate` below it then had no width limit to truncate against. jsdom does not lay out, so no unit test can catch this.

The fix forces that wrapper to `display: block` from the consumer: `className="[&_[data-slot=scroll-area-viewport]>div]:block!"` on `ScrollArea` (`plugins/agent-overview/agent-overview.tsx`). The `!` is needed because the wrapper's display is an inline style. `src/renderer/src/components/ui/scroll-area.tsx` was left unchanged, because it is shadcn source and other uses may want horizontal scrolling.

## Implication

A vertical-only `ScrollArea` whose rows truncate text needs the same `block!` override. Check truncation in the running app (`verify-in-app`) with a long value; tests cannot show it.
