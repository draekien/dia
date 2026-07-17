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

## Implication

Never animate per-delta for streamed content. Reveal from a buffer on a frame
timer. When adding markdown rendering on top, note that live markdown reflows at
block boundaries mid-stream (a `#` becoming a heading, a fence closing) — that
reflow is inherent and accepted, distinct from the delta-driven jerk this entry
is about.
