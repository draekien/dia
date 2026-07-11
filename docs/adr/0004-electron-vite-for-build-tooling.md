---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Use electron-vite for build tooling

## Context and Problem Statement

Electron apps need a build/dev pipeline that compiles the main, preload, and renderer processes correctly and provides a fast local dev loop. Which build tool should scaffold and build dia?

## Decision Drivers

* Fast dev feedback loop (HMR) across all three Electron process types.
* Native TypeScript support.
* Active maintenance and current best-practice status, not just historical popularity.

## Considered Options

* electron-vite
* Electron Forge (with `@electron-forge/plugin-vite`)

## Decision Outcome

Chosen option: "electron-vite", because it is purpose-built around Vite for exactly the main/preload/renderer split Electron requires, supports HMR across all three, and — confirmed via current research at decision time — remains the actively maintained, recommended default for new Electron projects in 2026. Electron Forge's own Vite plugin is still marked experimental by the Forge team, whereas Forge's experimental features are generally developed first in electron-vite and ported to Forge once stable.

### Consequences

* Good, because dev-loop speed (HMR for main + renderer) is materially better than non-Vite alternatives.
* Good, because it's a lighter, more focused tool than Forge — just build tooling, not a full packaging/distribution suite.
* Bad, because packaging and auto-update tooling (which Forge provides out of the box) will need to be added separately (e.g. via `electron-builder`) as those needs arise.

## Pros and Cons of the Options

### electron-vite

* Good, because it's Vite-native with correct architecture separation for main/preload/renderer.
* Good, because it is the current, actively maintained recommendation for new projects (verified via web research, not assumed from prior knowledge).
* Bad, because it doesn't include packaging/distribution — that's a separate concern to solve later.

### Electron Forge (Vite plugin)

* Good, because Forge is the official Electron toolchain and includes packaging/auto-update out of the box.
* Bad, because its Vite integration is explicitly marked experimental, with the plugin author's own docs noting features land in electron-vite first.

## More Information

Packaging/auto-update tooling (e.g. `electron-builder`) is intentionally out of scope for this ADR and should be decided separately when release/distribution needs are defined.
