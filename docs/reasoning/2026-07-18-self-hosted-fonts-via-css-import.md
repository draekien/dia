# Self-hosted webfonts via CSS `@import`, not a JS side-effect import

**Date:** 2026-07-18

## Context

The `typeset` pass committed dia's first real typefaces (Geist Sans + Geist Mono) via the `@fontsource-variable/*` packages. First attempt loaded them with side-effect imports in `main.tsx` (`import '@fontsource-variable/geist'`), mirroring the existing `import 'highlight.js/styles/github-dark.css'`.

## Reasoning / Learning

- **A bare-specifier side-effect import fails typecheck.** `import '@fontsource-variable/geist'` resolves (via the package's `.` export) to `index.css`, which has no type declarations, so `tsc` errors `TS2882: Cannot find module or type declarations for side-effect import`. The existing `highlight.js/.../github-dark.css` import only passes because its specifier ends in `.css`. Appending the explicit `/index.css` path also silences TS2882 — but the cleaner fix is not to import fonts from TS at all.
- **Font loading belongs in the stylesheet.** Move it to `src/renderer/src/index.css` as `@import '@fontsource-variable/geist';` (and `-geist-mono`), placed immediately after `@import 'tailwindcss';` and before `@plugin`. This keeps all styling concerns in one file and sidesteps the TS side-effect-import issue entirely. The Tailwind v4 Vite plugin resolves the bare specifier from `node_modules`.
- **These are self-hosted, not CDN.** `pnpm build` emits the `geist-*-wght-normal-*.woff2` files into `out/renderer/assets/` — the fonts ship inside the app bundle (correct for an offline Electron app; no runtime network fetch, no layout shift, no privacy leak).
- Fonts are wired as `--font-sans` / `--font-mono` tokens in the `@theme inline` block (family names `'Geist Variable'` / `'Geist Mono Variable'`), so Tailwind's `font-sans` / `font-mono` utilities pick them up with no per-component changes.

## Implication

When adding a webfont (or any CSS-only asset package) to the renderer, `@import` it from `index.css` rather than a `.ts`/`.tsx` side-effect import. Reserve JS side-effect CSS imports for cases that genuinely need them, and if one is unavoidable use an explicit `.css` specifier to avoid TS2882.
