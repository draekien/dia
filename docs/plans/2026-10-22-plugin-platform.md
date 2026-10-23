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

Result (2026-10-22, issue #5): every check passed in a packaged build and no fallback is used. Results, setup requirements and open items are in `docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`.

## Phase 1 — Host process with today's features

Scope: topology change only, no plugin system yet.

1. Create the Host as a `utilityProcess` whose entry registers tsx with `register()` from `tsx/esm/api` (ADR-0021, Phase 0 result). Main and the Host exchange startup values (the WebSocket port and token) over `parentPort`, not argv or environment variables.
2. Move the session logic from `src/main/pane-process/agent-session.ts` into the Host, one child `Scope` per pane.
3. Move supervision from `src/main/services/pane-supervisor.ts` into the Host; main starts and restarts the Host only.
4. Define the `src/shared/ipc/contract.ts` messages as an `effect/rpc` `RpcGroup`, serve it over the WebSocket with `RpcServer.makeProtocolWithHttpEffectWebsocket`, and reimplement `window.dia` in `src/preload/index.ts` as an `effect/rpc` client (ADR-0022).
5. Move `pane-workspace.ts`, `persistence.ts`, `transcript-reader.ts`, `git-ops-service.ts` and `settings-store.ts` into the Host unchanged.
6. Serve the packaged renderer from the custom scheme `dia://app` with Electron's `protocol.handle`. The Host refuses a WebSocket upgrade whose `Origin` header is not on its allowlist: `dia://app`, plus the electron-vite dev server origin in a dev build.
7. Hand the WebSocket port and token to the renderer through the preload. The renderer sends the token as the subprotocol `dia.token.<hex>` (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`).

The renderer and the Host check that they speak the same protocol version when the WebSocket opens. A browser reports every refused upgrade as close code 1006 (Phase 0), so the Host accepts the upgrade and then closes the connection with an application close code (4000–4999) that names the mismatch, instead of answering HTTP 426.

A dropped WebSocket must not lose or repeat work:

- Each pane event carries a per-pane sequence number. The Host keeps each pane's recent events in memory. A renderer subscription carries the last sequence number it received; the Host sends the buffered events after it, or tells the renderer to reload the pane's history from the transcript when the buffer no longer holds them. The buffer is not persisted: a Host restart ends every query, and history then comes from the SDK transcript.
- Each command from the renderer carries a client-generated `commandId`. The Host ignores a command whose `commandId` it has already accepted for that pane, so a renderer that resends after a reconnect does not, for example, send a prompt twice.

When the Host process exits for any reason, every `claude` process its queries started also exits. It has not been checked whether the Agent SDK already ends its CLI child when the parent process dies on Windows; check that and choose the mechanism in this phase.

A `SendMessage` to a pane with no live session must not be dropped: the Host creates the pane's `Scope` on demand. This replaces the dropped plan `docs/plans/2026-07-20-auto-recover-dead-pane-on-send.md`.

When a pane's `Scope` closes because its session failed, every event the pane produced before the failure, including the `Crashed` attention state, reaches the renderer before the subscriber that forwards the pane's events is interrupted. Close the pane's event queue and wait for the subscriber to finish before closing the `Scope`; do not rely on fiber scheduling order. Today `src/main/services/pane-supervisor.ts` relies on an `Effect.yieldNow` between `markCrashed` and `teardown` for this (`docs/reasoning/2026-10-22-effect-v4-migration-runtime-gotchas.md`), and the test "removes a pane that crashes unexpectedly" covers it.

Done when: every MVP success criterion in `docs/prds/mvp.md` that held before Phase 1 still holds, and `pnpm typecheck`, `pnpm lint`, `pnpm test` and a manual run of the installed build pass.

Result (2026-10-23, issue #6): the Host, the RPC WebSocket, the replay buffer, the `commandId` dedupe, the protocol-version close code and on-demand pane start are implemented, and `pnpm typecheck`, `pnpm lint` and `pnpm test` pass. A manual run of the unpackaged build and of the `electron-builder --dir` build (tsx in the Host, esbuild and `claude.exe` unpacked) streamed a reply, survived a Host kill with a window reload and history restore, started a cold pane on `SendMessage`, and shut down through the Host. `claude` processes end when the Host dies, so no extra mechanism was added. Details and the cases not covered are in `docs/reasoning/2026-10-23-host-process-phase-1-findings.md`. The NSIS installer was not built or installed.

## Phase 2 — Kernel registry and loader

Scope: `host`-side plugin lifecycle. No hot reload yet.

1. Plugin manifest schema in `src/shared`, including the API version field. The loader refuses a plugin whose API version differs from the installed app's.
2. Registry: one `Scope.fork` per plugin; registrations acquired with `Effect.acquireRelease`; service slots; dependency-driven restart of dependants when a service changes (ADR-0019).
3. Loader: default copies from the installer, per-plugin source overrides persisted in settings (ADR-0020).
4. Renderer registry with the same lifecycle for `renderer` entries.

Done when: a test plugin in `plugins/` loads, unloads and reloads by API call without interrupting a streaming turn in another pane.

Result (2026-10-23, issue #7): the manifest (`plugin.json`: `name`, `api`, `host`, `renderer`, `inject`), the registry, the Host loader with persisted overrides, the `window.dia.plugins` calls (protocol version 3) and the renderer registry are implemented, and `pnpm typecheck`, `pnpm lint` and `pnpm test` pass. In a manual run of the unpackaged build, `plugins/example` loaded at startup; 20 reloads over 5.1 s during a 1500-line reply in another pane left the reply complete and contiguous; an override in a directory with no `node_modules` loaded, re-imported changed code, failed cleanly on a wrong API version and on a syntax error, and returned to the default copy when cleared. Details and the cases not covered are in `docs/reasoning/2026-10-23-plugin-kernel-phase-2-findings.md`. The renderer registry loads at renderer startup and is not yet driven by the Host's load calls (Phase 3). The NSIS installer was not built or installed.

## Phase 3 — Hot reload and the creator loop

1. Per-module generations: the loader's resolve hook gives each module under a plugin root its own generation, not one per root. A reload caused by a source change bumps the generation of the changed module and of its importers up to the plugin entry; every other module keeps its URL. A load or reload with no source change adds no module records. Node has no public API to evict an ES module (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`), so records of old generations stay in memory until the Host restarts; growth is bounded by the number of source changes, not the number of reloads.
2. Rollback: when a reload fails, the registry re-imports the previous generation's entry and reopens it, with status `Loaded` and the failure message reported, instead of leaving the plugin closed as `Failed`.
3. Host HMR: watch the files of overridden plugins only; shipped plugins are not watched. Map each change to the owning plugin entry and reload it as in items 1 and 2. A change outside the plugin root (a Host or framework dependency) sets status `RestartRequired` and does not reload.
4. Renderer HMR: in-app Vite dev server while any renderer override is active; remount the rebuilt plugin.
5. Plugin panel: list of plugins, the path each loads from, override and clear actions, last reload error.
6. In-process MCP server per pane session with `dia_plugin_override`, `dia_plugin_reload` and `dia_plugin_clear_override`, each gated by `canUseTool`.

Design inputs: Vite replaces only the HMR boundary module, not its importers (https://vite.dev/guide/api-hmr). deepseek-harness evicts changed modules and their importers, rolls back a failed replacement and reports `restart-required` for dependency changes (`packages/boot/hmr/README.md` in https://github.com/deepseek-ai/deepseek-harness); its eviction uses Node loader internals, which a packaged `utilityProcess` does not expose, so Phase 3 does not copy it. Both were read through documentation lookups; the deepseek-harness behaviour is as documented in its notes, not checked in its source.

Measure before Phase 3 is done: process memory after 200 source edits to `plugins/example`, to confirm that growth follows edits and not reloads.

Done when: an agent in a pane, working in a worktree of dia, edits a plugin, loads it with `dia_plugin_override`, observes the change, and opens a pull request with `gh pr create`, without the user leaving the pane.

## Phase 4 — Move features into built-in plugins

Scope: one feature per change, in this order. dia stays usable after each.

1. SDK message → protocol mapping (`agent-session-reducer.ts`)
2. Permission mode (`permission-mode-controller.ts`) and pending user input (`pending-user-input.ts`)
3. Thinking level (`thinking-options.ts`)
4. Worktrees (`git-ops-service.ts`, worktree parts of `pane-workspace.ts`)
5. File checkpointing and rewind (ADR-0018)
6. Layout: replaced by step 3 (agent overview sidebar) of `docs/plans/2026-10-23-agent-os.md`, which removes the split layout (`src/shared/domain/pane-tree.ts`) and its renderer (ADR-0023)
7. Chat UI, permission card, question card
8. Updater (`updater.ts`)

Decide during step 6 what renderer plugins can replace: named slots only, or the whole layout.

## Dropped

`docs/plans/2026-07-20-auto-recover-dead-pane-on-send.md` is dropped. Phase 1 removes the per-pane process whose death that plan handles. The bug it describes (a `SendMessage` to a pane with no live session is dropped) must not exist after Phase 1, because the Host creates a pane's `Scope` on demand.

## Roadmap — not in this plan

* Third-party plugins: a third-party plugin is a GitHub repository, installed with `pnpm add` using a git specifier, following deepseek-harness's Plugin Manager (`packages/boot/plugin-manager/README.md`, branch `master`).
* Trust model for third-party plugins. First-party plugins run with full Node access.
* A browser or phone client of the Host's WebSocket (ADR-0022).
* The agent OS features in `docs/prds/agent-os.md` (projects and tabs, agent overview, notifications, meta project) are built as built-in plugins once Phase 2 provides the loader; their plan is `docs/plans/2026-10-23-agent-os.md`.
