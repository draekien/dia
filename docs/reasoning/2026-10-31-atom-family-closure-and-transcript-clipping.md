# State in an `Atom.family` closure outlives its registry; transcript items clip focus rings

**Date:** 2026-10-31

## Context

`paneRewindAtom` (`src/renderer/src/lib/pane-chat-atoms.ts`) keeps its current `RewindProgress` and its timeout handle in variables declared in the `Atom.family` callback, because an atom's write function gets a `WriteContext` with no `self()` (`node_modules/effect/src/reactivity/Atom.ts`, `WriteContext`). Its tests, each with a new `AtomRegistry`, failed: a rewind started in one test was still `rewinding` in the next.

The rewind control under an agent turn (`plugins/chat/rewind-action.tsx`) also showed its focus ring cut off on the bottom and left in the running app.

## Reasoning / Learning

- `Atom.family` caches one atom per key for the whole process, not per registry. Variables in the family callback are therefore shared by every registry that reads that key. The atom's `read` function runs once per registry node, so `read` resets the closure (`current = idle`, clears the timer) before returning it.
- `TranscriptItem` (`plugins/chat/transcript-scroller.tsx`) sets `content-visibility: auto`, which applies paint containment. Paint outside the item's box is clipped, so the default outset 3 px focus ring of a button at the item's edge is cut off. `focus-visible:ring-inset` draws the ring inside the button instead.

## Implication

- Reset any per-node state kept in an `Atom.family` closure in the atom's `read` function, or tests that share a key across registries see each other's state.
- A focusable control placed at the edge of a transcript item needs an inset ring or padding inside the item.
