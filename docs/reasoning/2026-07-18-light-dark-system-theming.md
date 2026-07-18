# Light / dark / system theming

**Date:** 2026-07-18

## Context

dia shipped dark-only: `index.css` held a single `:root` palette. Adding
user-selectable light / dark / system themes touched the CSS palette, the
main-process settings store, IPC, the renderer, and syntax highlighting. A few
choices here are non-obvious and were deliberate.

## Reasoning / Learning

- **Class-based dark mode needs `@custom-variant dark`.** The theme is switched
  by toggling `.dark` on `<html>`; the semantic role vars (`--background`, …) are
  re-pointed in a `.dark {}` block, so token utilities (`bg-background`) flip for
  free. But any `dark:`-prefixed utility still keys off Tailwind v4's default
  `prefers-color-scheme` unless you add `@custom-variant dark (&:is(.dark *))`.
  This matters because the prose bodies use `dark:prose-invert` — without the
  custom variant, prose text wouldn't follow the class toggle.
- **Syntax highlighting is hand-authored `--syntax-*` role vars, not an imported
  hljs theme.** highlight.js theme stylesheets (e.g. `github-dark.css`) all target
  bare `.hljs`/`.hljs-*` selectors, so you can't scope two of them under `:root`
  vs `.dark` via `@import` (an import can't prefix the file's selectors). Instead,
  `main.tsx` no longer imports any hljs theme; `index.css` maps the hljs token
  classes to ~9 `--syntax-*` role vars that flip between github-light and
  github-dark values in the `:root`/`.dark` blocks. Self-contained, theme-aware,
  and no vendored-CSS drift.
- **No-flash is an accepted tradeoff, not solved.** The preference persists in the
  main-process `SettingsStore` (per the user's choice) and is read over async IPC,
  so it isn't known at first paint. `index.html` hard-codes `class="dark"` as the
  pre-hydration default and the `ThemeProvider` reconciles once `getTheme()`
  resolves — applying the stored theme exactly once (the provider leaves the class
  untouched until it loads, to avoid flipping through an interim value). A
  light-preference user therefore sees a brief dark flash on cold start. The
  zero-flash fix (read the theme before `createWindow` and pass it via
  `webPreferences.additionalArguments`, then apply in an inline `<head>` script)
  was deferred as out of scope.
- **White-alpha literals don't survive a theme flip.** The code-block inline-code
  background, line-number border, and scrollbar thumb were `oklch(1 0 0 / …)`
  (white tints, fine on dark). They're now
  `color-mix(in oklch, var(--ink) N%, transparent)` so they tint with the ink
  colour and read correctly in both modes.

## Implication

When adding a themed asset that ships its own colours (a syntax theme, a
third-party widget's CSS), prefer mapping it onto `--*` role vars that live in the
`:root`/`.dark` blocks over importing a mode-specific stylesheet you can't scope.
If the startup theme flash becomes annoying, the `additionalArguments` +
inline-script path above is the fix.
