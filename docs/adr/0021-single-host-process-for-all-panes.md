---
status: "accepted"
date: 2026-10-22
decision-makers: William Pei
---

# Run every pane's agent session and all non-UI plugins in one Host process

## Context and Problem Statement

ADR-0003 runs the Agent SDK in an Electron `utilityProcess` brokered by main, and ADR-0007 runs one `utilityProcess` per pane (`utilityProcess.fork` in `src/main/services/pane-supervisor.ts`). Under ADR-0019 non-UI plugins load into the processes that hold the agent sessions. With a process per pane, a pane-level plugin loads once per pane and a plugin that reacts across panes needs IPC between processes. Where do the agent sessions and non-UI plugins run?

## Decision Drivers

* A plugin that observes several panes (for example, a sound when any pane completes a turn) must be one plugin instance with one context.
* A plugin reload must not restart a process (ADR-0019).
* Electron main changes only on a dia core update, so it should hold as little reloadable logic as possible.
* Each SDK `query()` already runs its own `claude` CLI child process, so CLI-level isolation between panes does not depend on dia's process layout.

## Considered Options

* One Host process for all panes
* One `utilityProcess` per pane (ADR-0007)

## Decision Outcome

Chosen option: "One Host process for all panes", because plugins then share one registry and one context tree, which is how deepseek-harness runs its plugins (`apps/desktop/README.md` in `deepseek-ai/deepseek-harness`: a private Host in an Electron Node-mode child).

| Process | Holds |
| --- | --- |
| Electron main | Window, titlebar overlay, native dialogs, starting and restarting the Host, handing the renderer the Host's address and token (ADR-0022) |
| Host | The kernel (ADR-0019), the plugin registry, all non-UI plugins, and one child `Scope` per pane owning that pane's SDK `query()` |
| Renderer | The renderer plugin registry and UI plugins |
| `claude` CLI | One per SDK `query()`, started by the SDK |

The Host is a `utilityProcess`. Phase 0 of `docs/plans/2026-10-22-plugin-platform.md` found that both a `utilityProcess` and an `ELECTRON_RUN_AS_NODE` child can load plugin source in a packaged build: the `utilityProcess` ignores `--import`, so its entry registers the tsx loader itself. The `utilityProcess` was chosen because it does not depend on the `runAsNode` fuse (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`).

This decision supersedes ADR-0007 and ADR-0003. ADR-0003 named the trigger for this change in its "More Information": revisit "if dia later needs multi-window shared sessions or remote access". ADR-0022 makes remote access possible.

### Consequences

* Good, because a plugin has two entry types (`host`, `renderer`) instead of three, and a pane is a child `Scope` that plugins observe directly.
* Good, because resource use no longer grows by one Node runtime per pane.
* Bad, because an uncaught defect in the Host's Node process ends every pane's SDK queries at once. A plugin's own failures are contained by closing its `Scope`; a defect outside any plugin scope is not.
* Bad, because `src/main/services/pane-supervisor.ts`, `src/main/pane-process/*` and `src/main/ipc/gateway.ts` are rewritten, and the plan `docs/plans/2026-07-20-auto-recover-dead-pane-on-send.md` (which fixes a dead pane process) no longer applies.

## Pros and Cons of the Options

### One Host process for all panes

* Good, because cross-pane plugins need no IPC.
* Good, because it matches deepseek-harness.
* Bad, because Node-side failures are shared by all panes.

### One `utilityProcess` per pane

* Good, because a Node-side failure affects one pane.
* Bad, because pane-level plugins load once per pane and cross-pane plugins coordinate through main over IPC.
* Bad, because a plugin has three entry types (`main`, `pane`, `renderer`).

## More Information

* Supersedes: ADR-0003, ADR-0007.
* Related: ADR-0019 (kernel), ADR-0020 (loading), ADR-0022 (transport).
