# `var(--muted-foreground)` does not exist at runtime, and an OKLCH blend from a near-grey changes hue

**Date:** 2026-11-01

## Context

The context donut (#86) builds its colour as a CSS `color-mix()` of theme tokens, so the blend follows the light and dark themes. The first version used `var(--muted-foreground)` as the neutral end and blended every stage `in oklch`. Unit tests passed, because they compare strings.

## Reasoning / Learning

Resolving each colour in the running app (dark theme) with `getComputedStyle(element).color` showed two faults:

| Expression | Resolved | Problem |
| --- | --- | --- |
| `var(--muted-foreground)` | `oklch(0.94 0.005 255)` | That is the foreground colour. The variable is undefined, so `color` falls back to the inherited value. |
| `color-mix(in oklch, var(--pulse-amber) 48%, var(--ink-muted))` | `oklch(0.6928 0.0846 339)` | Hue 339 is pink. |
| `color-mix(in oklab, var(--pulse-amber) 48%, var(--ink-muted))` | `oklab(0.6928 0.0242 0.0646)` | Hue about 70, a muted amber. |
| `color-mix(in oklch, var(--pulse-red) 60%, var(--pulse-amber))` | `oklch(0.672 0.196 43)` | Correct. |

- `src/renderer/src/index.css` declares `--color-muted-foreground: var(--ink-muted)` inside `@theme inline`. Tailwind v4 inlines `@theme inline` values into utilities and does not emit them as CSS variables, so only the `:root`/`.dark` variables (`--ink-muted`, `--pulse-amber`, `--pulse-red`, …) exist at runtime.
- OKLCH interpolates hue along the shorter arc. `--ink-muted` has hue 255 at chroma 0.015, so a blend with amber (hue 70) passes through 339. OKLab has no hue angle, so the near-grey end adds almost nothing to the hue.

## Implication

In inline styles and `color-mix()`, reference the `:root` variables (`--ink-muted`), never the `--color-*` names from `@theme inline` or the shadcn names they map. Blend from a near-grey in OKLab; blend between two saturated colours in OKLCH. Check a computed colour in the running app, because a string comparison in a unit test cannot detect an undefined variable.
