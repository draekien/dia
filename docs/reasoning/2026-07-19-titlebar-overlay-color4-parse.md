# `setTitleBarOverlay` rejects CSS Color 4 strings

**Date:** 2026-07-19

## Context

Starting the app in dev mode crashed the main process with `TypeError: Could not parse color as CSS color` inside `window.setTitleBarOverlay`. The renderer's `theme-provider.tsx` recolours the OS window-control overlay whenever the theme changes, reading the token values it sends from `getComputedStyle(probe).color`.

## Reasoning / Learning

dia's theme tokens (`--surface`, `--ink`, …) are authored in `oklch(...)`. Chromium's `getComputedStyle().color` does **not** down-convert those to legacy `rgb(...)` — it serializes the computed value as a CSS Color 4 string (`oklab(...)`/`oklch(...)`). That string travels over IPC to the main process, where Electron's native `setTitleBarOverlay` color parser only understands legacy formats (hex / `rgb()` / named). It rejects Color 4 syntax and throws, which is an *uncaught* exception in the main process — so it takes the whole app down rather than degrading the overlay.

Fix: convert the computed color to a plain sRGB `#rrggbb` before sending, by round-tripping through a 1×1 canvas (`ctx.fillStyle = value` → `ctx.getImageData().data`). The canvas 2D context accepts any CSS Color 4 string and normalises it to sRGB pixels, so this reliably flattens whatever `getComputedStyle` produces.

Ruled out: reading a different property or forcing `rgb()` in CSS — the serialization is Chromium's choice, not controllable from the token definitions.

## Implication

Any color value crossing the renderer→main IPC boundary for a native Electron API (title-bar overlay, `nativeTheme`, tray, `BrowserWindow` background) must be a legacy-format string. Don't hand computed `oklch`/`oklab` values to Electron — flatten to sRGB hex first (`toSrgbHex` in `theme-provider.tsx`).
