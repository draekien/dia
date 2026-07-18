# Streaming text: decouple visual reveal from network cadence

**Date:** 2026-07-17

## Context

Animating the assistant's streaming text inside a pane. The first attempt
animated each arriving delta (fade in the newly-appended chunk, keyed on
`streamingText.length`). It looked "jerky and disjointed."

## Reasoning / Learning

The Agent SDK delivers `assistant_text_delta` events in irregular bursts —
variable chunk sizes at variable intervals. Any animation keyed to the delta
boundary is therefore frame-locked to bursty network input, so it *is* jerky by
construction: a chunk starts fading, the next delta snaps it to full opacity
mid-fade and starts another. Per-delta motion can't be smooth because the input
isn't.

The fix is the technique production chat UIs use: **decouple the visual cadence
from the network cadence.** Buffer the full incoming string and reveal it at a
steady, `requestAnimationFrame`-driven rate, advancing `revealedLength` toward
`text.length` each frame by a proportional catch-up step
(`ceil(gap / divisor)`). The rAF loop reads the target from a ref updated on
every render, so it never needs to re-subscribe when text grows — the effect
runs once with `[]` deps and the loop self-tracks. Proportional catch-up drains
large bursts quickly then eases to ~1 char/frame, so it tracks generation speed
without ever lagging far behind or stuttering.

Reduced motion: same loop, but the step jumps straight to `target` (instant
reveal), rather than a separate branch that would need `text` in deps.

The blinking cursor is a pure-CSS `::after` on the markdown wrapper's
`> :last-child`, so it sits inline at the end of the last rendered block without
any DOM juggling — the ChatGPT-style block caret.

## Update (2026-07-18): proportional catch-up → time-based capped reveal

The proportional `ceil(gap / divisor)` step above is **front-loaded**: it drains
most of a burst in the first 2-3 frames, then idles once caught up. That was
tolerable while text arrived per-delta synchronously (old TanStack Query
`streamingText` path), but the move to `useChat` routes deltas through the Effect
`Stream` → `toAsyncIterable` → processor `for await` bridge, which **batches** the
microtask-fast IPC deltas into coarser, more spaced bursts. The front-loaded
reveal then reads as "each segment streams in really fast, then a pause" — the
exact jerk this entry set out to kill, reintroduced by a burstier source.

Fix: reveal at a **time-based, speed-capped** rate instead of a per-frame
fraction. `nextRevealLength(current, target, dtMs)` (pure, unit-tested) advances
at `clamp(backlog / revealWindowMs, minCps, maxCps)` characters/second, integrated
over the real elapsed `dtMs` (so it is frame-rate independent). The ceiling stops
a big batch from dumping in one frame (kills the "really fast"); draining a fixed
backlog window keeps the reveal continuously busy across the gaps (kills the
"pause"). The loop keeps a fractional `revealedRef` accumulator and renders
`Math.floor` of it. Reduced motion still jumps straight to `target`.

## Implication

Never animate per-delta for streamed content. Reveal from a buffer on a frame
timer, and pace that reveal by **elapsed time with a capped rate**, not a
per-frame fraction of the backlog — the fraction is front-loaded and stutters
when the source is bursty (and `useChat`'s async pipeline is burstier than a
synchronous per-delta path). Tune the reveal in `nextRevealLength`, not the loop.
When adding markdown rendering on top, note that live markdown reflows at block
boundaries mid-stream (a `#` becoming a heading, a fence closing) — that reflow is
inherent and accepted, distinct from the delta-driven jerk this entry is about.
