---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Use pnpm with a single-package repo layout

## Context and Problem Statement

dia needs a package manager and a repository layout decision: should the Electron main, preload, and renderer code live in one package, or be split into a pnpm workspace of multiple packages (e.g. separate packages for shared types, main, renderer)?

## Decision Drivers

* Current scope is a single desktop app, not a suite of deployables.
* Avoid premature structure that isn't justified by current requirements (per project conventions: no speculative abstraction).
* pnpm is the preferred package manager for disk efficiency and strict dependency resolution.

## Considered Options

* pnpm, single package
* pnpm workspace (monorepo) with separate packages per process/concern

## Decision Outcome

Chosen option: "pnpm, single package", because dia is currently one deployable (one Electron app), and a monorepo split (main/renderer/shared-types as separate packages) would add workspace configuration overhead with no current benefit. Main, preload, and renderer code are organized as folders within the single package, which electron-vite already expects (see [ADR-0004](0004-electron-vite-for-build-tooling.md)).

### Consequences

* Good, because there's no workspace/monorepo tooling to configure or maintain.
* Good, because it matches electron-vite's default project structure.
* Bad, because if dia later grows into multiple deployables (e.g. a CLI, a shared library, a standalone agent service per [ADR-0003](0003-agent-sdk-runs-in-electron-utility-process.md)'s "More Information" note), this will need to be revisited as a workspace.

## Pros and Cons of the Options

### pnpm, single package

* Good, because it's the simplest structure that fits the app's current, single-deployable scope.
* Bad, because sharing types/code with a hypothetical future second deployable would require extraction work later.

### pnpm workspace (monorepo)

* Good, because it would scale cleanly if dia grows into multiple deployables.
* Bad, because it adds workspace configuration and cross-package dependency management with no current justification.

## More Information

Revisit if a second deployable (e.g. a standalone agent service, per [ADR-0003](0003-agent-sdk-runs-in-electron-utility-process.md)) becomes necessary.
