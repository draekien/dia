---
status: "accepted"
date: 2026-10-22
decision-makers: William Pei
---

# Load first-party plugins from source in the dia repo, with per-plugin worktree overrides and hot reload

## Context and Problem Statement

Under ADR-0019 every dia feature is a plugin and the user refines plugins while using the installed app, raising a pull request for each refinement. Where does first-party plugin source live, how does the installed app turn a source edit into loaded code, and which checkout does it load from when several panes refine different plugins in parallel worktrees?

## Decision Drivers

* An edit made by a pane's agent must reach the installed app without a manual build step.
* A refinement must already be in the dia repo's history so the pull request is `gh pr create` from the worktree that holds it.
* Several panes, each in its own worktree (US-5 in `docs/prds/mvp.md`), must be able to refine different plugins at once.
* The installed app must keep working with no checkout present.
* Follow the loading model of `deepseek-ai/deepseek-harness` and `cordiverse/cordis`.

## Considered Options

* Source loading: the installed app loads plugin TypeScript through a loader hook and serves renderer plugins from an in-app Vite dev server
* External watcher: a `pnpm plugins:watch` script in the checkout writes `plugins/*/dist`, and the installed app re-imports changed output
* Installed app compiles plugin source with a bundled esbuild

## Decision Outcome

Chosen option: "Source loading", because it is the model cordis and deepseek-harness use, and it needs no process besides dia to be running.

| Concern | Rule |
| --- | --- |
| First-party plugin location | `plugins/<name>/` in the dia repo |
| Plugin package contents | A manifest (name, API version, `host` and `renderer` entries) and TypeScript source |
| Default copy | The installer ships a prebuilt copy of every first-party plugin. With no override set, the installed app loads the prebuilt copy |
| Override | Each plugin can be pointed at a source path, normally `<worktree>/plugins/<name>`. Overrides are per plugin; other plugins keep their default copy |
| Two overrides for one plugin | The most recent override wins. The plugin panel shows the path every plugin is loaded from |
| Host plugins under an override | Loaded through a TypeScript loader hook (`tsx`) in the Host process (ADR-0021). The Host watches the files it has imported, follows the import graph to the owning plugin entry, evicts those modules, closes the plugin's `Scope` and loads it again (ADR-0019) |
| Renderer plugins under an override | Served by a Vite dev server the installed app runs while any renderer override is active. The rebuilt plugin is remounted with fresh state |
| Failed reload | The plugin stays unloaded until the next change. The failure is logged and shown in the plugin panel |
| Shared runtime libraries | `react`, `effect` and the dia plugin API are provided by the host and never bundled into a plugin, so only one copy of each exists at runtime |
| Clearing an override | The plugin returns to its default copy. Done after the refinement ships in a release |

Third-party plugins are out of scope for this decision and on the roadmap: a third-party plugin is a GitHub repository, installed with `pnpm add` using a git specifier, following deepseek-harness's Plugin Manager (`packages/boot/plugin-manager/README.md`). cordis itself resolves only npm package specifiers and local paths (`packages/loader/src/config/tree.ts` in `cordiverse/cordis`).

### Consequences

* Good, because an agent's edit hot-reloads with nothing besides dia running.
* Good, because each refinement lives on its own worktree branch and becomes one pull request.
* Bad, because the installer ships `tsx` and Vite, and the repo's path aliases (`tsconfig.base.json`, `electron.vite.config.ts`, `vitest.config.ts`) need a fourth declaration in the in-app loader and dev server.
* Bad, because Node has no public API that evicts an ES module, so a reload imports the plugin's modules again under new URLs and the previous instances stay in memory. cordis's HMR instead deletes from Node's internal `loadCache` with `--expose-internals` (`packages/hmr/src/index.ts` in `cordiverse/cordis`), which a packaged Electron 43 `utilityProcess` does not honour (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`).

## Pros and Cons of the Options

### Source loading

* Good, because no build process has to be running.
* Good, because it matches cordis and deepseek-harness.
* Bad, because the Host must register the tsx loader itself: a packaged Electron 43 `utilityProcess` ignores `--import`, and the esbuild binary tsx spawns must be unpacked from `app.asar` (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`).

### External watcher

* Good, because the repo's own build is the only build configuration.
* Good, because re-importing with a cache-busting URL needs no Node internals.
* Bad, because a watcher process must be running, and the loading model differs from the references.

### Installed app compiles with bundled esbuild

* Good, because nothing besides dia runs.
* Bad, because the in-app build configuration must track the repo's aliases and tsconfig, the same cost as source loading, without the reference implementations to follow.

## More Information

* Phase 0 of `docs/plans/2026-10-22-plugin-platform.md` verified source loading and module eviction in a packaged build, so the external-watcher fallback is not used. The loader setup, the eviction method and the `"type": "module"` requirement for plugin directories are in `docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`.
* References: Koishi dev mode runs `koishi start -r esbuild-register` and production loads prebuilt `lib/` (`en-US/guide/develop/script.md` in `koishijs/docs`); Koishi's console runs a Vite dev server at runtime in dev mode (`plugins/console/src/node/index.ts` in `koishijs/webui`); deepseek-harness HMR watches loaded source files and does not restore the previous version on failure (`packages/boot/hmr/README.md`, branch `master`).
* Related: ADR-0019 (kernel and lifecycle), ADR-0021 (Host process).
