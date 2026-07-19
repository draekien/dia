---
status: "accepted"
date: 2026-07-19
decision-makers: William Pei
---

# Replace the native window frame with a custom titlebar and native overlay controls

## Context and Problem Statement

dia shipped with the default OS window chrome (a full native titlebar above the
renderer). We want a small persistent app header that belongs to the app — it
carries the dia wordmark and the self-update indicator — rather than a separate
OS titlebar stacked on top of it, wasting vertical space and breaking the
"Control Room" single-surface feel. How should dia own the top strip of the
window while keeping the OS window controls (minimize / maximize / close)?

## Decision Drivers

* Keep the minimize/maximize/close controls native — correct per-OS behaviour,
  positioning, and accessibility, at zero maintenance cost.
* Give the app a single owned header strip instead of app-header-below-OS-titlebar.
* Avoid re-implementing window dragging, snap layouts, and control semantics by
  hand.
* Stay within Electron's supported, cross-platform APIs (per ADR-0001).

## Considered Options

* **`titleBarStyle: 'hidden'` + `titleBarOverlay` (native overlay controls).**
* **`frame: false` (fully frameless) with custom-drawn window controls.**
* **Keep the default native frame** and put the app header below it.

## Decision Outcome

Chosen option: "`titleBarStyle: 'hidden'` + `titleBarOverlay`", because it hides
the native titlebar while keeping the OS drawing the window controls in an
overlay region, so dia renders its own draggable header across the rest of the
strip without owning control behaviour. The renderer keeps content clear of the
buttons with `env(titlebar-area-width)` and marks the header
`-webkit-app-region: drag` (interactive children opt out with `no-drag`).

To stop the overlay's button glyph background from clashing with the theme, the
renderer computes the exact `--surface` / `--ink` token colours from live CSS
(via a hidden probe element read with `getComputedStyle`) and pushes them to the
main process through `setTitleBarOverlay` on every theme change; the main process
sets a rough `nativeTheme.shouldUseDarkColors` default pre-mount so the first
paint isn't jarring.

### Consequences

* Good, because window controls stay native — no re-implementation of min/max/
  close, snap layouts, or their per-OS semantics and a11y.
* Good, because dia owns one header strip that doubles as the drag region and the
  home for the update indicator.
* Good, because overlay colours track the theme exactly, with no second source of
  truth for the palette.
* Bad, because `titleBarOverlay` is Windows/Linux-centric; macOS renders the
  traffic-light buttons differently and ignores the overlay colour/height fields
  (acceptable — dia targets Windows first, per the packaging work in ADR-0016).
* Bad, because a small amount of glue exists (probe-element colour read, an IPC
  channel) to keep the native overlay in sync with CSS tokens.

## Pros and Cons of the Options

### `titleBarStyle: 'hidden'` + `titleBarOverlay`

* Good, because the OS keeps ownership of the window controls.
* Good, because `env(titlebar-area-width)` and `-webkit-app-region` are the
  first-class, documented way to lay out a custom titlebar around them.
* Bad, because colour sync with the theme needs explicit glue.

### `frame: false` with custom controls

* Good, because it gives total visual control of the buttons.
* Bad, because we would re-implement minimize/maximize/restore/close, hover and
  active states, snap-layout affordances, and accessibility per OS — high effort,
  ongoing maintenance, and easy to get subtly wrong.

### Keep the default native frame

* Good, because zero work.
* Bad, because the app header sits below a redundant OS titlebar, wasting vertical
  space and undercutting the single-surface "Control Room" feel.

## More Information

Implementation lives in `src/main/index.ts` (window config, overlay default,
updater listeners), `src/renderer/src/components/app-header.tsx` (the custom
titlebar), `src/renderer/src/components/theme-provider.tsx` (token → overlay
push), and the `setTitleBarOverlay` IPC path across the contract, gateway, and
preload. Builds on ADR-0001 (Electron shell) and complements ADR-0016
(distribution and auto-update — the update indicator this header hosts).
