---
status: accepted
date: 2026-11-13
decision-makers: William Pei
---

# A `dia-runs` plugin owns every agent session and a `dia-run-events` plugin owns their event log, and tabs, org and the inbox are views or drivers of runs

## Context and Problem Statement

The kernel opens an agent session only for a tab: `SessionFactory` in `src/host/services/pane-supervisor.ts` calls `AgentBackend.openSession` with `diaTools: pluginTools` and `tools: Option.none()`. A plugin that needs an agent without a tab opens the session itself (ADR-0067) and shows it through `ctx.sessions.attach` (ADR-0070, `src/host/services/attached-sessions.ts`). The org plugin therefore implements its own headless runner, turn-state tracking, permission queue (`PendingPermission`), restart requeue and concurrency cap in `plugins/org/dispatcher.ts` (751 lines) and `plugins/org/scheduler.ts`. The kernel also owns the event log (`agent_events`, `agent_items` in `host.db`, `src/host/services/agent-event-store.ts`), the recorder (`agent-event-recorder.ts`), the chat projection (`pane-chat-projection.ts`) and the session RPCs in `DiaRpcs` (`src/shared/ipc/rpc.ts`), deduplicated by `commandId` (`src/host/ipc/rpc-handlers.ts`). t3code (`ProviderSessionManager`), deepseek-harness (`ctx.agents`) and paperclip (`heartbeat_runs`) each make an agent run a core concept that tabs and features drive. deepseek-harness keeps no session code in its core: `packages/core/session` (event log), `packages/session/session-projection` and `packages/api/session-controller` (the UI-facing API) are plugins. What should dia's agent session concept be, and where should its parts live?

## Decision Drivers

* A feature plugin composes agent runs; it does not implement a session runner.
* A permission, question or plan-review request is answerable from any view, not only from the pane that opened it.
* Every feature is a plugin (ADR-0019).
* A reload or restart must not lose agent work that can be resumed, and must not start turns nobody asked for.
* A command the renderer resends after a reconnect applies once.

## Considered Options

* `dia-runs` and `dia-run-events` plugins own sessions, the event log and the UI-facing session API
* `dia-runs` owns run lifetime and uses kernel seams for the event log, projection and session RPCs
* A kernel `RunService` owns run lifetime; policies are plugins
* A work item (issue plus wakeup) is the core concept
* A terminal pane running the `claude` CLI is the core concept

## Decision Outcome

Chosen option: "`dia-runs` and `dia-run-events` plugins own sessions, the event log and the UI-facing session API", because it keeps every session part a replaceable plugin, as deepseek-harness does, and replaces the tab-only session path and the org runner with one service.

`dia-run-events`:

* Owns the event log and item projection in its own database: the content of `agent_events`, `agent_items` and `agent_transcript_cursors` moves from `host.db`. A one-time handover copies existing rows from `host.db` at its first start.
* Events are keyed by run id. Events are deleted only when `dia-runs` deletes the run, never because no tab references the run.
* Serves event streams and snapshots to renderer plugins through plugin streaming calls (ADR-0068).
* Replaces `agent-event-store.ts`, `agent-event-recorder.ts`, `pane-chat-projection.ts`, `transcript-reader.ts` and `agent-summaries.ts` in `src/host/services/`.

`dia-runs`:

* Provides a run service: start, steer, queue text, interrupt, resume and wait for a run; read and answer a run's open requests; list runs. A run is an agent session that exists with or without a tab, and has a row in `dia-runs`'s database.
* Holds each run's permission, question and plan-review requests as data and publishes them. Any plugin answers one through the run service.
* Serves the UI-facing session calls (send, steer, interrupt, answer a request, rewind, set model, thinking and permission mode) from its host entry. Each call carries a `requestId`; a call whose `requestId` is already recorded in the run's events returns the first result and applies nothing (deepseek-harness `packages/api/session-controller/src/commands.ts`).
* Exports the `AgentBackend` contract and `AgentBackendKey`, moved from `src/host/session/agent-backend.ts`. An adapter plugin such as `dia-claude-code` imports the contract from `dia-runs` and provides a backend. `model-catalog-feed.ts`, `model-preferences.ts` and `adapter-status-feed.ts` move from `src/host/services/` into `dia-runs`.
* Passes each run's MCP servers, including the `dia` server of ADR-0075 with the run's token, to `AgentBackend.openSession`. An adapter does not use the `dia-tools` registry.
* Reads `AgentBackendKey`, `ToolsKey`, `McpServerRegistryKey` and `SkillSourceRegistryKey` with `ctx.whenProvided`, not `inject`, so that a reload of a provider does not close `dia-runs` (ADR-0019 `inject` rule).
* Recovery: `dia-runs` stores each run's status. When `dia-runs` starts, after a reload or at Host start, it resumes each run whose status says a turn was in progress, with its session id and a continue message. A run that was idle or waiting for the user is not resumed. A run in progress without a session id ends as interrupted and offers a Resume action. A resumed turn may repeat the tool call that was in progress, including a call with side effects such as `git push`.

The renderer:

* A chat tab is a view of one run. A tab references a run id.
* A plugin's renderer entry calls another plugin's host entry through a plugin API that `docs/plans/2026-11-13-foundation.md` adds before `dia-runs`; `callHost` today reaches only the calling plugin's own host entry (`src/renderer/src/lib/plugin-messages.ts`).

The kernel keeps the three `plugin_*` tools (`src/host/session/dia-tools.ts`). Each runs its plugin operation in a kernel fiber detached from the calling run, so that a reload of `dia-runs` or `dia-claude-code` requested by a run completes after that run's turn ends. The kernel registers the tools with `dia-tools` (ADR-0075).

This ADR supersedes the first row of ADR-0019's kernel table, ADR-0050, ADR-0067 and ADR-0070. It amends ADR-0022 (session RPCs leave `DiaRpcs`), ADR-0043 (an agent row no longer owns events), ADR-0051 and ADR-0052 (the event store moves out of `host.db`), ADR-0055 (a reload of `dia-runs` or `dia-run-events` interrupts agent turns), ADR-0057 (cross-plugin renderer calls), ADR-0062 and ADR-0065 (`AgentBackendKey` is no longer a host key, and an adapter depends on `dia-runs`).

### Consequences

* Good, because org, chat and any later feature start agents through one service and hold no session code.
* Good, because one inbox can list and answer the requests of every run.
* Good, because every session part can be reloaded or replaced like any other plugin.
* Bad, because a reload of `dia-runs` or `dia-run-events` interrupts every running turn, and the resumed turn may repeat a tool call with side effects.
* Bad, because two plugin API additions (cross-plugin renderer calls, and the event streams `dia-run-events` serves) must exist before `dia-runs` can replace the kernel's session path.
* Bad, because existing transcripts move from `host.db` to `dia-run-events`'s database once, and a failed handover leaves tabs without history until it is retried.

## Pros and Cons of the Options

### `dia-runs` owns run lifetime and uses kernel seams for the event log, projection and session RPCs

* Good, because the event store, recorder, projection and `commandId` deduplication work as they are, and no plugin API changes.
* Bad, because the kernel keeps session-specific code that only `dia-runs` calls.

### A kernel `RunService` owns run lifetime; policies are plugins

* Good, because a running turn survives the reload of any plugin, as ADR-0019 requires today.
* Bad, because the run service is the one feature that stays outside the plugin model.

### A work item (issue plus wakeup) is the core concept

* Good, because org work maps onto it directly (paperclip, `server/src/services/heartbeat.ts`).
* Bad, because ad-hoc chat becomes a special work item, and issues move into the kernel.

### A terminal pane running the `claude` CLI is the core concept

* Good, because any agent CLI works (herdr, https://herdr.dev/docs/concepts/).
* Bad, because dia loses the Agent SDK's typed events, `canUseTool` callback and in-process tools.

## More Information

* Delivery order and the org freeze: ADR-0076. Tool registry used by runs: ADR-0075.
* The name `dia-run-events` is provisional.
* What the Agent SDK does when it resumes a session whose last entry is an unanswered tool call. <!-- unverified -->
* Comparison sources: `.repos/t3code` (commit dated 2026-11-05), `.repos/deepseek-harness` (2026-11-04), `.repos/paperclip` (2026-11-06), herdr docs at https://herdr.dev/docs/ (read 2026-11-13).
