---
status: "accepted"
date: 2026-07-17
decision-makers: William Pei
---

# Extract cross-process schemas into a platform-neutral `src/shared` module

## Context and Problem Statement

dia's Effect Schema definitions that describe the wire contract between processes — the pane domain model (`attention`, `pane`, `pane-tree`) and the IPC contract (`contract`) — are consumed by all three sides: main, preload, and renderer. They originally lived under `src/main/` and were reached from preload and renderer via an `@main/*` path alias. Where should code that is genuinely shared across the process boundary live, and how do we keep it importable everywhere without dragging main-only (Node/Electron) code into the renderer bundle?

## Decision Drivers

* The renderer bundles a web build; shared schema code must stay platform-neutral (no `node:`/`electron`/DOM dependencies) so it is safe to import there.
* Importing `@main/...` into the renderer misrepresents the boundary — it reads as "renderer reaches into main" when the code is really shared. This got sharper once the renderer began importing schema *values* (`.make` constructors), not just erased types.
* The web `tsconfig` had to enumerate each shared file by hand in its `include`; every new shared schema silently risked a broken renderer build until someone remembered to add it.
* Keep the single-package layout of [ADR-0006](0006-pnpm-single-package-repo-layout.md) — no workspace/monorepo overhead.
* Avoid speculative structure: only formalize sharing that already exists.

## Considered Options

* Keep schemas under `src/main`, imported cross-process via `@main`.
* Extract them into a dedicated `src/shared/` folder with an `@shared` alias and a platform-neutral tsconfig project.
* Split shared code into a separate pnpm workspace package.

## Decision Outcome

Chosen option: "Extract into `src/shared/`", because the sharing is already real (four files consumed by all three processes) and a folder-plus-alias names that boundary honestly while staying within one package. The four modules (`domain/attention`, `domain/pane`, `domain/pane-tree`, `ipc/contract`) moved to `src/shared/`, reached everywhere via an `@shared/*` alias declared in `tsconfig.base.json` and mirrored in `electron.vite.config.ts` (main, preload, renderer) and `vitest.config.ts`. The `@main` alias, now unused, was removed.

A dedicated `tsconfig.shared.json` typechecks `src/shared` in isolation with `lib: ["ES2022"]` and `types: []` (no DOM, no Node), so any platform-specific global in shared code fails `pnpm typecheck`. This is the enforcement that a plain folder rename would not provide.

This does **not** supersede [ADR-0006](0006-pnpm-single-package-repo-layout.md): `src/shared` is a folder within the single package, consistent with main/preload/renderer already being folders.

### Consequences

* Good, because the cross-process boundary is named honestly (`@shared`, not `@main`) and the renderer no longer appears to reach into main.
* Good, because `tsconfig.shared.json` mechanically enforces platform-neutrality — a Node or DOM global in shared code is now a typecheck failure, not a latent bundling bug.
* Good, because the web `tsconfig` includes `src/shared/**/*` by glob instead of an enumerated allowlist, so new shared schemas need no config bookkeeping.
* Bad, because there is now a fourth tsconfig project (and its `.tsbuildinfo`) to keep in step with the others.
* Neutral, because main-only IPC code that merely *depends* on shared schemas (e.g. the pane-process `protocol`, the `gateway` handlers) stays in `src/main`; only the shared contract itself moved.

## Pros and Cons of the Options

### Keep schemas under `src/main`

* Good, because it required no move.
* Bad, because `@main` in the renderer misnames the boundary, nothing enforced platform-neutrality, and the web `tsconfig` needed a hand-maintained per-file include list.

### Dedicated `src/shared/` folder + `@shared` alias + neutral tsconfig

* Good, because it formalizes existing sharing, enforces neutrality, and stays a single package.
* Bad, because it adds one more tsconfig project to maintain.

### Separate workspace package

* Good, because it would scale cleanly to multiple deployables.
* Bad, because it adds workspace tooling and cross-package dependency management with no current justification — the same reasoning that drove [ADR-0006](0006-pnpm-single-package-repo-layout.md).

## More Information

Revisit the workspace-package option if a second deployable emerges (see [ADR-0006](0006-pnpm-single-package-repo-layout.md) and [ADR-0003](0003-agent-sdk-runs-in-electron-utility-process.md)). The `.make()` construction convention that motivated the renderer's runtime dependency on shared schemas is recorded in the root `CLAUDE.md`.
