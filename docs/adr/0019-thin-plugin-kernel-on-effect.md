---
status: "accepted"
date: 2026-10-22
decision-makers: William Pei
---

# Build dia as a thin plugin kernel on Effect, with every feature as a plugin

## Context and Problem Statement

dia's features (pane sessions, permission handling, thinking level, worktrees, split layout, chat UI, updater) are fixed code in `src/main` and `src/renderer`. The goal is for dia to work like `deepseek-ai/deepseek-harness` ("Everything is a Plugin", built on `cordiverse/cordis`): plugins add, replace, or remove behaviour while the app runs, and the user refines plugins through use. How much of dia becomes a plugin, what stays in a non-reloadable kernel, and which library provides the plugin lifecycle?

## Decision Drivers

* A plugin reload must not interrupt an agent turn that is streaming. Only an update to dia's core may restart processes.
* Every user-facing feature, including the ones dia ships with, must be replaceable or removable by a plugin.
* dia's process code is written in Effect (ADR-0010). A second lifecycle and disposal system would have to be bridged in every plugin.
* An agent running in a pane must be able to load and reload the plugin it is editing, so the edit → reload → check loop runs without the user.

## Considered Options

* Thin kernel on Effect; every feature is a built-in plugin
* Fixed core with extension points
* Thin kernel on cordis; Effect used inside plugins

## Decision Outcome

Chosen option: "Thin kernel on Effect; every feature is a built-in plugin", because it is the only option where every feature is replaceable and the lifecycle model stays the one the codebase already uses.

The kernel holds only:

| Kernel responsibility | Why it cannot be a plugin |
| --- | --- |
| Agent SDK `query()` lifetime per pane, its input queue, its `sessionId` | A streaming turn must survive the reload of any plugin that observes or alters it |
| Host process supervision (ADR-0021) | Reloads happen inside the processes the supervisor owns |
| Renderer ↔ Host transport (ADR-0022) | Plugins communicate across processes through it |
| Plugin registry, loader, HMR (ADR-0020) | It performs the loading and unloading of plugins |

Everything else becomes a built-in plugin that uses the same API a user plugin uses, for example the logic now in `agent-session-reducer.ts`, `permission-mode-controller.ts`, `pending-user-input.ts`, `thinking-options.ts`, `pane-workspace.ts`, `git-ops-service.ts`, `pane-tree.ts`, `updater.ts` and the renderer chat and permission UI.

The plugin lifecycle follows cordis's design, implemented with Effect 4.0.5 primitives:

| cordis concept | dia implementation |
| --- | --- |
| Plugin fiber; disposers run in reverse on unload | One `Scope.fork` per loaded plugin; every registration is acquired with `Effect.acquireRelease`; unload is `Scope.close` |
| `ctx.on(event)` | `PubSub` subscription acquired in the plugin's scope |
| `ctx.provide(service)` swapped live | Registry-held service slot; the replacement is published to dependants |
| `inject: [service]` restarts dependants when the service changes | Built in dia: the registry closes and reopens the scope of every plugin that depends on a changed service tag |

The kernel also gives each pane session an in-process MCP server (Agent SDK custom tools, `docs/llms/agent-sdk.txt` "Give Claude custom tools") with `dia_plugin_override`, `dia_plugin_reload` and `dia_plugin_clear_override`. Each call goes through the pane's `canUseTool` permission flow, because a plugin change affects every pane. A plugin panel in the renderer performs the same operations by hand. Pull requests are not a dia feature: the pane's agent runs `gh` from the worktree.

### Consequences

* Good, because built-in features and user plugins use one API, so any feature can be replaced or disabled.
* Good, because a plugin reload closes only that plugin's `Scope` (and its dependants'), so the kernel-owned `query()` keeps streaming.
* Good, because one disposal model (`Scope`) covers kernel and plugins.
* Bad, because dia builds and maintains its own registry, dependency-driven restart, loader and HMR instead of reusing cordis's.
* Bad, because plugins from cordis, Koishi or deepseek-harness cannot be loaded; those plugins inject services dia does not provide.

## Pros and Cons of the Options

### Thin kernel on Effect; every feature is a built-in plugin

* Good, because every feature is replaceable.
* Good, because it matches ADR-0010.
* Bad, because the plugin machinery is dia's own code.

### Fixed core with extension points

* Good, because only the extension points need building.
* Bad, because layout, chat UI and any behaviour without a hook cannot be changed by a plugin.

### Thin kernel on cordis; Effect used inside plugins

* Good, because cordis ships a registry, a loader (`@cordisjs/plugin-loader`) and HMR (`@cordisjs/plugin-hmr`).
* Bad, because every plugin bridges a cordis fiber to an Effect runtime and its typed errors.
* Bad, because cordis v4 is a release candidate (`4.0.0-rc.12` on the npm `latest` tag at 2026-10-22).

## More Information

* cordis design read from `cordiverse/cordis` at commit `34c8ac5`: `packages/core/src/fiber.ts`, `packages/core/src/registry.ts`, `packages/core/src/reflect.ts`.
* deepseek-harness design read from `deepseek-ai/deepseek-harness` branch `master`: `docs/architecture.md`, `packages/boot/hmr/README.md`, `packages/core/agent-loop/README.md`. In deepseek-harness the agent loop is itself a plugin and turn survival across a reload is not stated; dia keeps `query()` in the kernel to guarantee it.
* Plugin API versioning: a plugin manifest declares an API version (for example `"api": "1"`) and the loader refuses a plugin built for another version. The field is `api` in `plugin.json` and the installed value is `PLUGIN_API_VERSION` in `src/shared/plugin/manifest.ts`; the registry refuses a plugin whose `api` differs (Phase 2 of `docs/plans/2026-10-22-plugin-platform.md`).
* Related: ADR-0020 (plugin source and loading), ADR-0021 (Host process), ADR-0022 (transport).
