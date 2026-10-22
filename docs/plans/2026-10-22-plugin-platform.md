# Plan: dia plugin platform

Status: **proposed**
Date: 2026-10-22
Driven by: the goal that dia works like `deepseek-ai/deepseek-harness`: every feature is a plugin, plugins hot-reload in the installed app, and refinements made through use become pull requests to the dia repo.
PRD: `docs/prds/plugin-platform.md`.
Decisions: ADR-0019 (thin kernel on Effect), ADR-0020 (source loading and overrides), ADR-0021 (one Host process), ADR-0022 (localhost WebSocket).
Verified against: repo at commit `5be38e6`.

## Rules for every phase

* Phases land on `main` in order. dia must be usable for dogfooding at the end of every phase.
* A plugin reload never interrupts a streaming turn. A phase that cannot meet this rule does not ship.
* Each phase ends with `pnpm typecheck`, `pnpm lint`, `pnpm test` and a manual run of the installed build.

## Phase 0 — Verification spike

Scope: throwaway code on a branch. Nothing merges except the findings, recorded in `docs/reasoning/`.

| Check | Pass condition | If it fails |
| --- | --- | --- |
| Host process type | A `utilityProcess` or an `ELECTRON_RUN_AS_NODE` child, started from a packaged build, imports a `.ts` file through `--import tsx` | Use the external-watcher fallback in ADR-0020 |
| Module eviction | A changed ES module is imported again with its new code in the chosen Host process type, either by evicting it from the loader cache or by a cache-busting URL | Use a cache-busting URL and accept that old module instances stay in memory |
| Kernel-owned `query()` | A `query()` keeps streaming while a plugin `Scope` that subscribes to its events is closed and reopened | Redesign the kernel/plugin boundary in ADR-0019 before Phase 1 |
| WebSocket handshake | The renderer connects to the Host on `127.0.0.1` with a token passed from main; a connection without the token is refused | Revisit ADR-0022 |

## Phase 1 — Host process with today's features

Scope: topology change only, no plugin system yet.

1. Create the Host process (type from Phase 0).
2. Move the session logic from `src/main/pane-process/agent-session.ts` into the Host, one child `Scope` per pane.
3. Move supervision from `src/main/services/pane-supervisor.ts` into the Host; main starts and restarts the Host only.
4. Serve the `src/shared/ipc/contract.ts` messages over the WebSocket (ADR-0022) and reimplement `window.dia` in `src/preload/index.ts` as its client.
5. Move `pane-workspace.ts`, `persistence.ts`, `transcript-reader.ts`, `git-ops-service.ts` and `settings-store.ts` into the Host unchanged.

Done when: every MVP success criterion in `docs/prds/mvp.md` that held before Phase 1 still holds.

## Phase 2 — Kernel registry and loader

Scope: `host`-side plugin lifecycle. No hot reload yet.

1. Plugin manifest schema in `src/shared`, including the API version field. The loader refuses a plugin whose API version differs from the installed app's.
2. Registry: one `Scope.fork` per plugin; registrations acquired with `Effect.acquireRelease`; service slots; dependency-driven restart of dependants when a service changes (ADR-0019).
3. Loader: default copies from the installer, per-plugin source overrides persisted in settings (ADR-0020).
4. Renderer registry with the same lifecycle for `renderer` entries.

Done when: a test plugin in `plugins/` loads, unloads and reloads by API call without interrupting a streaming turn in another pane.

## Phase 3 — Hot reload and the creator loop

1. Host HMR: watch imported files of overridden plugins, map changes to the owning plugin entry, evict, close and reopen the plugin's `Scope`.
2. Renderer HMR: in-app Vite dev server while any renderer override is active; remount the rebuilt plugin.
3. Plugin panel: list of plugins, the path each loads from, override and clear actions, last reload error.
4. In-process MCP server per pane session with `dia_plugin_override`, `dia_plugin_reload` and `dia_plugin_clear_override`, each gated by `canUseTool`.

Done when: an agent in a pane, working in a worktree of dia, edits a plugin, loads it with `dia_plugin_override`, observes the change, and opens a pull request with `gh pr create`, without the user leaving the pane.

## Phase 4 — Move features into built-in plugins

Scope: one feature per change, in this order. dia stays usable after each.

1. SDK message → protocol mapping (`agent-session-reducer.ts`)
2. Permission mode (`permission-mode-controller.ts`) and pending user input (`pending-user-input.ts`)
3. Thinking level (`thinking-options.ts`)
4. Worktrees (`git-ops-service.ts`, worktree parts of `pane-workspace.ts`)
5. File checkpointing and rewind (ADR-0018)
6. Split layout (`src/shared/domain/pane-tree.ts`) and its renderer
7. Chat UI, permission card, question card
8. Updater (`updater.ts`)

Decide during step 6 what renderer plugins can replace: named slots only, or the whole layout.

## Dropped

`docs/plans/2026-07-20-auto-recover-dead-pane-on-send.md` is dropped. Phase 1 removes the per-pane process whose death that plan handles. The bug it describes (a `SendMessage` to a pane with no live session is dropped) must not exist after Phase 1, because the Host creates a pane's `Scope` on demand.

## Roadmap — not in this plan

* Third-party plugins: a third-party plugin is a GitHub repository, installed with `pnpm add` using a git specifier, following deepseek-harness's Plugin Manager (`packages/boot/plugin-manager/README.md`, branch `master`).
* Trust model for third-party plugins. First-party plugins run with full Node access.
* A browser or phone client of the Host's WebSocket (ADR-0022).
