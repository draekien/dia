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

1. Per-module generations: the loader's resolve hook gives each module under a plugin root its own generation, not one per root. A reload caused by a source change bumps the generation of the changed module and of its importers up to the plugin entry; every other module keeps its URL. A load or reload with no source change adds no module records. Node has no public API to evict an ES module (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`), so records of old generations stay in memory until the Host restarts; growth is bounded by the number of source changes, not the number of reloads. cordis's eviction through the addon `node-addon-require-builtin` is not an option: it runs only on Electron 43.0.0, 44.0.0, 44.7.0 and 45.0.0-alpha.6, so using it would pin Electron below 44.9.3 (`docs/reasoning/2026-10-24-module-eviction-addon-spike.md`).
2. Change detection: each load compares the size and modification time of every module the loader imported for that plugin with the values recorded at the previous load, so a reload triggered by hand or by an agent picks up exactly the files that changed. A change to a file outside the plugin root that a plugin module imports directly (a Host or framework dependency) cannot be reloaded; the plugin keeps running its current version with status `RestartRequired`.
3. Rollback: the registry imports and checks the new version (manifest, API version, entry import) before it closes the running plugin, so a failure at those steps leaves the running version untouched (cordis does the same in its first stage). A failure in the new version's own setup, after the old scope closed, reopens the previous setup. In both cases the plugin has status `Loaded` and the failure message is reported as its last reload error. A failure on the first load, with no previous version, is `Failed`.
4. Memory safeguard: the registry totals, per plugin, the memory its loads added since the Host started. The total grows after each load by the growth of the Host's heap across that load, measured after a garbage collection before and after it. At 100 MB a plugin's `load` stops importing, leaves the running version in place, and returns status `RestartRequired` with the reason `memory` and the measured size; `unload` still works. Restarting dia resets every total. The heap is shared with every pane, so growth from other activity during a load is counted against the plugin: the total is an estimate.
5. Paused (user request, 2026-10-24): Host file watcher for overridden plugins, and renderer HMR through an in-app Vite dev server. Neither is built until the user resumes them. A reload is triggered by `window.dia.plugins.load` and by the agent tool in item 7.
6. Plugin management page: a dedicated page, opened from the command palette, listing every plugin with the path it loads from, its state, its last reload error and its memory total. Actions: reload, unload, set an override through a native folder picker, clear an override.
7. In-process MCP server per pane session with the tools `plugin_override`, `plugin_reload` and `plugin_clear_override` (the model sees `mcp__dia__plugin_override` and so on). Every call requires the user's approval in every permission mode. The SDK does not call `canUseTool` for an MCP tool under `bypassPermissions` or when an allow rule matches (`docs/reasoning/2026-10-24-phase-3-research-findings.md`), so the approval must not depend on `canUseTool` alone.

Design inputs: Vite replaces only the HMR boundary module, not its importers (https://vite.dev/guide/api-hmr). cordis imports the new code first and keeps the old plugins running when that import fails, and leaves a plugin failed when its setup fails (`packages/hmr/src/index.ts` in https://github.com/cordiverse/cordis). deepseek-harness evicts changed modules and their importers and reports `restart-required` for dependency changes (`packages/boot/hmr/README.md` in https://github.com/deepseek-ai/deepseek-harness); both evict through Node loader internals, which a packaged `utilityProcess` does not expose, so Phase 3 does not copy that. The cordis and deepseek-harness behaviour was read through documentation lookups, not checked by running it.

Measure before Phase 3 is done: process memory after 200 source edits to `plugins/example`, and a run that reaches the 100 MB safeguard with a fixture plugin that holds a large module-level array.

Result (2026-10-24, issue #8, items 1 to 4, 6 and 7; item 5 stays paused): implemented as ADR-0026 and `docs/designs/phase-3-plugin-loader.md`. In a manual run of the unpackaged build, 200 source edits of `plugins/example` grew the plugin's total from 19.7 MB to 22.3 MB and the Host's working set from 137 MB to 145 MB; a fixture module holding a 300 000-object array reached 101.3 MB at edit 11 and edit 12 returned `RestartRequired` (memory); a syntax error in an edit left the plugin `Loaded` with `reloadError` and the next good edit cleared it; a real agent called `plugin_reload` and was asked once in `auto`, `default` and `acceptEdits`, and the SDK refused the call in `dontAsk`. Details and the cases not covered are in `docs/reasoning/2026-10-24-phase-3-implementation-findings.md`. Not covered: a packaged build, `bypassPermissions` (dia has no such mode), the "Done when" scenario end to end (an agent editing a plugin in a worktree and opening a pull request), a dependency change that gives `RestartRequired` in the running app (covered by a child-process test only), and the renderer registry being driven by the Host's load calls.

Done when: an agent in a pane, working in a worktree of dia, edits a plugin, loads it with `dia_plugin_override`, observes the change, and opens a pull request with `gh pr create`, without the user leaving the pane.

## Phase 4 — Move features into built-in plugins

Scope: one feature per change, in this order. dia stays usable after each.

Mechanism, decided in step 1 (`docs/designs/session-reducer-plugin.md`, `docs/reasoning/2026-10-24-plugin-runtime-api-spike.md`): a built-in plugin imports host runtime values (protocol schemas, service keys) from `@dia/plugin`, which the loader's resolve hook maps to the built `out/main/plugin-api.js`; the kernel reads a plugin's service with `PluginRegistry.inject` and keeps a minimal fallback for when none is provided.

1. SDK message → protocol mapping (`agent-session-reducer.ts`). Result (2026-10-24): moved to `plugins/session-reducer`; the kernel creates each session's reducer with `makeSessionReducer`. In the unpackaged app and in an `electron-builder --dir` build, `session-reducer` loaded at startup and a real prompt produced 3 text deltas, the assistant reply, 1 checkpoint and `Idle` → `Completed` → `Idle`; with the plugin unloaded and the session restarted, the same prompt produced 0 deltas, 0 checkpoints, the full reply, a completed turn and a logged warning. Not covered: the NSIS installer, a plugin reducer that throws in the running app (unit tests only), and reloading `session-reducer` while a turn streams. Follow-up: #23 (decide how to display every SDK message type).

   Startup change between steps 1 and 2 (ADR-0027, `docs/designs/lazy-plugin-startup.md`, 2026-10-24): `plugin.json` has `load: "eager" | "lazy"`, and `HostReady` waits for eager plugins only (`session-reducer` is eager). Lazy plugins load afterwards, and each state change reaches the renderer as `PluginStatusChanged` (`PROTOCOL_VERSION` 5). In the unpackaged app with a 5 s eager and an 8 s lazy test plugin: the `Starting dia` placeholder showed for about 5 s, `Eager plugins settled` was logged before `Host ready`, the header showed `Loading plugins 3 of 4` until the lazy plugin settled at 13.7 s, and a prompt sent while it still loaded produced 3 deltas, the reply and `Idle` → `Completed` → `Idle`. Not covered: a packaged build, the NSIS installer, a reconnect during startup, and naming the loading plugin before `HostReady`.
2. Permission mode (`permission-mode-controller.ts`) and pending user input (`pending-user-input.ts`). Result (2026-10-24): moved to the essential plugin `plugins/permissions` (ADR-0028, `docs/designs/permissions-plugin.md`). The Host refuses to unload or override an essential plugin (`ESSENTIAL_PLUGINS`), and a session whose `permissions` plugin is unavailable denies every tool call. In the unpackaged app: `unload('permissions')` returned `Loaded`, `setOverride('permissions', …)` returned `Rejected`, a reload returned `Loaded`, and a prompt that needed the `Write` tool produced `Idle` → `AwaitingPermission`, then after `Allow` the reply, `Completed` and `Idle`. With `plugins/permissions/host.ts` forced to fail (`permissions:Failed`), a prompt that needed `Write` produced no request card, the `Write` and `Bash` calls were denied with a logged warning, and the turn completed. Reloading `permissions` while a request was pending left the request answerable: `Allow` completed the turn. The `electron-builder --dir` build gave the same `permissions:Loaded`, `AwaitingPermission`, reload and `Completed` sequence. A reload of `permissions` that fails keeps the running version and its services (unit test). Not covered: the NSIS installer, and a first load of `permissions` that fails in a packaged build.
3. Thinking level (`thinking-options.ts`). Result (2026-10-24): moved to the essential plugin `plugins/thinking` (`docs/designs/thinking-plugin.md`); the kernel resolves the options once per session start with `resolveThinkingOptions` and uses `{}` when the plugin is unavailable. In the unpackaged app: `thinking:Loaded`, a pane created with level `high` logged `Resolved thinking options` with `{ thinking: { type: 'adaptive' }, effort: 'high' }` and the turn completed; `unload('thinking')` returned `Loaded`; with `plugins/thinking/host.ts` forced to throw (`thinking:Failed`) the same prompt logged `The thinking plugin is not loaded; the thinking level is ignored` and the turn completed. Not covered: a packaged build, the NSIS installer, `setOverride('thinking', �)` in the running app (unit-tested for `permissions` only), and whether the SDK's default thinking differs observably from `high`.
4. Worktrees (`git-ops-service.ts`, worktree parts of `pane-workspace.ts`). Result (2026-10-24): the git operations and the name generator moved to the essential plugin `plugins/git-ops` (`docs/designs/git-ops-plugin.md`); `PaneSupervisor` resolves them with `resolveGitOps` each time a pane opens, and `pane-workspace.ts` needed no change beyond its imports. In the unpackaged app, with a throwaway repo: `git-ops:Loaded`, `unload('git-ops')` returned `Loaded`, a pane created with a worktree added `dia-dev/worktrees/amber-falcon` on branch `dia/amber-falcon`, the session ran in it, a prompt completed, and `closePane` removed the worktree. With `plugins/git-ops/host.ts` forced to throw (`git-ops:Failed`), `createPane` with a worktree was refused with `WorktreeCreateError` (`The git-ops plugin is not loaded`), no worktree was created and no session started. The `electron-builder --dir` build first failed (`Cannot find package 'redis'`, from importing the `@effect/platform-node` index) and passed after importing `@effect/platform-node/NodeServices`: `git-ops:Loaded`, worktree `plucky-harbor` created and removed, turn completed (`docs/reasoning/2026-10-24-plugin-import-platform-node-subpath.md`). Not covered: the NSIS installer, `reattachWorktree` on resume in the running app (supervisor unit test only), a reload of `git-ops` while a worktree pane is open, and the memory cost of the plugin's 34.5 MB total against a lower limit.
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
