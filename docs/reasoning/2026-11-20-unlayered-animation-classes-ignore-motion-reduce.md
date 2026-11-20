# Unlayered animation classes ignore `motion-reduce:animate-none`

**Date:** 2026-11-20

## Context

The startup stream (ADR-0089) classes its log lines `animate-stream-enter motion-reduce:animate-none` and its pinned dot `animate-pulse-slow motion-reduce:animate-none`, as `StatusWorking` in `src/renderer/src/components/status-indicator.tsx` does. In a packaged build with `prefers-reduced-motion: reduce` emulated over CDP (`Emulation.setEmulatedMedia`), `matchMedia('(prefers-reduced-motion: reduce)').matches` was `true`, yet `getComputedStyle` still returned `animation-name: stream-enter` for a line and `pulse-slow` for the dot.

## Reasoning / Learning

`src/renderer/src/index.css` defines `.animate-pulse-slow` and `.animate-stream-enter` outside any `@layer`. Tailwind v4 emits `motion-reduce:animate-none` inside `@layer utilities`. A rule outside every cascade layer takes precedence over any layered rule, whatever the specificity or source order, so the `animation: none` utility never applies to those two classes. The same defect affected `StatusWorking`'s pulse before this change.

The fix adds `.animate-pulse-slow` and `.animate-stream-enter` to the unlayered `@media (prefers-reduced-motion: reduce)` rule in `index.css` that already stops `.stream-cursor`'s caret. That rule comes later in the file than the class definitions, so its `animation: none` wins. After the fix, both elements compute `animation-name: none` under the emulated preference and keep animating without it.

jsdom does not evaluate `prefers-reduced-motion`, so a vitest test cannot observe this; only a computed-style read in the running app does.

## Implication

A custom animation class defined in `index.css` outside `@layer` must also be listed in the unlayered `@media (prefers-reduced-motion: reduce)` rule. Adding `motion-reduce:animate-none` beside it in a component has no effect. Check a reduced-motion criterion with a computed-style read under `Emulation.setEmulatedMedia` in the app.
