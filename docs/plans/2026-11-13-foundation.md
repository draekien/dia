# Plan: dia's foundation capabilities

Status: **not started**
Date: 2026-11-13
Decisions: ADR-0074 (`dia-runs`, `dia-run-events`), ADR-0075 (`dia-tools`), ADR-0076 (foundation before org, org frozen), ADR-0077 (`dia-` plugin names), ADR-0078 (plugin data migrations)
Reviewed: 2026-11-13, findings applied to ADR-0074 to ADR-0078 and this plan.

Paths in the "Replaces" column are the names before step 1.

## Steps

Each step is one plugin, or one change to an existing plugin or the plugin API, and depends only on earlier steps. A step is done when every line in its "Done when" column is shown in the running app (`verify-in-app` skill) or by a test.

| # | Step | Replaces | Done when |
| --- | --- | --- | --- |
| 0 | Freeze org: move `plugins/org` to `archive/org` (ADR-0076) | — | `pnpm typecheck`, `pnpm test` and `pnpm build` pass without `archive/`; dia starts without org; `<userData>/plugins/org` is untouched |
| 1 | Plugin data migrations and `PathsMoved` (ADR-0078); rename every plugin to `dia-<name>` (ADR-0077) | `ctx.dataDir` naming in `src/host/plugins/host-plugins.ts` | every folder under `plugins/` starts with `dia-`; after first start each `<userData>/plugins/<old>` is at `<userData>/plugins/dia-<old>`; an existing worktree tab opens, `git worktree list` in its repo shows the new path, and its conversation resumes; issues and MCP servers show their existing data; `pluginOverrides` and model preferences survive; a run with both old and new folders present fails with an error naming both |
| 2 | Plugin API: a renderer entry calls another plugin's host entry; event streams from a plugin host entry reach any renderer plugin | `callHost` reaching only the calling plugin (`src/renderer/src/lib/plugin-messages.ts`) | plugin A's renderer calls a method of plugin B's exported RPC group and receives a typed result; a resent call is visible to the handler as a resend |
| 3 | `dia-run-events`: event log, item projection and chat snapshots in its own database (ADR-0074) | `agent-event-store.ts`, `agent-event-recorder.ts`, `pane-chat-projection.ts`, `transcript-reader.ts`, `agent-summaries.ts` in `src/host/services/` | existing conversations show the same history after the one-time copy from `host.db`; restarting dia twice does not copy twice; no event is deleted because a tab closed |
| 4 | `dia-runs`: runs, requests as data, UI-facing session calls with `requestId` deduplication, the `AgentBackend` contract, recovery; chat tabs view runs (ADR-0074) | `SessionFactory` in `pane-supervisor.ts`; `attached-sessions.ts`; session RPCs in `src/shared/ipc/rpc.ts`; `src/host/session/agent-backend.ts`; `model-catalog-feed.ts`, `model-preferences.ts`, `adapter-status-feed.ts` | a tab chats, queues and steers, rewinds and parks (ADR-0041, ADR-0045) as before; a run with no tab runs to completion, survives a restart, and opens in a tab; a `SendMessage` resent after a reconnect sends one message; reloading `dia-runs` mid-turn resumes that turn and does not start a turn in an idle run; `plugin_reload` of `dia-runs` from inside a run completes and is not repeated; no file in `src/` imports `AgentBackend` |
| 5 | `dia-inbox`: every open request across runs (ADR-0076) | `PendingUserInput` routing that only reaches the pane | a permission request from a run with no tab appears in the inbox and the answer resumes the run; the same request answered in a tab disappears from the inbox |
| 6 | `dia-tools`: registry and the HTTP, SSE, stdio and in-process transports (ADR-0075) | `AgentSessionOptions.diaTools`; `DiaTool`; `plugins/claude-code/tool-server.ts` | a plugin registers a Schema-typed tool and a run whose `ToolScope` matches calls it over HTTP, and the handler receives the run's `context`; a call without a token, with a revoked token or with a foreign `Origin` is refused; `plugin_*` tools work in a tab and are absent for an outside token; `DIA_MCP_TOKEN=<token> dia-mcp`, configured as a stdio server in Claude Code in a terminal, lists the tools |
| 7 | Run queue (ADR-0076) | `plugins/org/scheduler.ts` | with a limit of 2, a run waiting for the user does not hold a slot; a third queued run starts when a turn ends; a per-key limit of 1 keeps a second run with the same key queued; a run whose request was answered resumes ahead of queued runs; a higher-priority run starts first |
| 8 | Agent messaging: `run_send`, `run_wait`, `run_delegate` tools (ADR-0076) | — | run A delegates a task to a new run B, waits, and receives B's result in its next turn |
| 9 | Schedules: interval and cron runs | `ctx.activities` for run starts | a schedule starts a run at its time, and a missed time while dia was closed follows the schedule's catch-up rule |
| 10 | `dia-git`: status, diff, log, branch, commit, push, worktree add and remove, ignore checks | `plugins/worktrees/git-ops.ts`; git calls in `plugins/meta/meta-repo.ts`, `plugins/meta/meta-push.ts`, `src/host/services/project-entries.ts` | `dia-worktrees` and `dia-meta` run no git process themselves; worktree create, release and meta push behave as before; the project file list works while `dia-git` reloads |
| 11 | Diffs and checkpoints per run, on `dia-git` | — | each run lists the files it changed and shows each file's diff per turn |
| 12 | Terminals and processes | — | a plugin opens a PTY in a run's working directory and the renderer shows it; a process a run started is listed and stoppable; the packaged installer starts on a clean Windows machine |
| 13 | Cost per run | — | each run shows input, output and cache tokens per turn and in total |
| 14 | Rewrite org on steps 3–13; move it back to `plugins/dia-org` | `archive/org`: `dispatcher.ts`, `scheduler.ts`, `session-tools.ts`, the `PendingPermission` table | an issue assigned to a hire starts a run in the issue's worktree through the run queue with a per-hire limit of 1, its issue tools receive the issue and hire through `ToolScope.context`, and its requests reach the inbox; the assistant hands work over through issues (ADR-0069, ADR-0071); hires and job titles from `<userData>/plugins/org` are present; `plugins/dia-org` has no `AgentBackend.openSession` call |

Questions each step settles in its own design document (`docs/designs/`):

* Step 2: whether ADR-0068 streaming calls cover the event streams of step 3, and the deduplication rule for a resent cross-plugin call.
* Step 6: how an agent outside dia obtains a token.
* Step 8: whether a message to a run wakes it (herdr `agent.prompt` does; paperclip @-mentions do not).
* Step 9: how schedules relate to `ctx.activities` (`src/shared/plugin/api.ts`).
* Step 11: how per-run checkpoints relate to the Agent SDK's file rewind (ADR-0045).
* Step 12: which PTY library, given that ADR-0042 and the packaging entries in `docs/REASONING.md` avoid native modules.
* Step 13: whether cost includes a dollar amount, which needs a price table.

## Baseline comparison (2026-11-13)

Sources: `.repos/t3code` (commit dated 2026-11-05), `.repos/deepseek-harness` (2026-11-04), `.repos/paperclip` (2026-11-06), herdr docs https://herdr.dev/docs/ (read 2026-11-13). Each cell names where the capability lives in that project.

| Capability | dia (`be67bfa`) | t3code | deepseek-harness | paperclip | herdr |
| --- | --- | --- | --- | --- | --- |
| Agent session without a tab | org only (`plugins/org/dispatcher.ts`) | `ProviderSessionManager`, `Run` | `ctx.agents` | `heartbeat_runs` via `agent_wakeup_requests` | pane with agent state |
| Requests as data | pane only (`PendingUserInput`) | `RuntimeRequest`, `runtime-request.respond` | `ctx.approval`, `ctx.userQuestions` | `approvals`, `issue_thread_interactions` | `blocked` state from screen detection |
| Attention inbox | none (ADR-0034 not built) | thread flags, mobile relay | none | `services/attention.ts` | notifications |
| Tool contribution | per `openSession` caller | MCP toolkits, `McpHttpServer` | `ctx.tools.register` | REST API, skill, `packages/mcp-server` | CLI and socket API |
| Agent-to-agent | org assistant creates issues (`routing-tools.ts`) | `delegate_task`, `t3_thread_send` | `ctx.subagents`, `ctx.agentTeams` | child issues and assignment wakeups | `agent.prompt`, `agent.wait` |
| Queue and schedules | `ctx.activities` timer | `Scheduler`, `ScheduledTaskService` | `ctx.jobs`, `ctx.schedule` | routines, heartbeat policy, budgets | none |
| Event record | `agent_events` in `host.db` | event store, pruned after about a day | `SessionEvent` log and projections | `heartbeat_run_events` | layout and resume ids only |
| Session API and retry deduplication | `DiaRpcs`, `commandId` | `ORCHESTRATION_V2_WS_METHODS`, `CommandReceiptStore` | `api/session-controller`, `requestId` in the session log | REST, run id header | socket API |
| Worktrees | `plugins/worktrees` | `ThreadLaunchService` | experimental `ctx.worktrees` | `execution_workspaces` | `worktree.*` socket API |
| Git operations | `plugins/worktrees/git-ops.ts`, `plugins/meta`, `project-entries.ts` each run git | `vcs/VcsDriver.ts`, `git/GitManager.ts` | `deliverables/workspace-changes` | `workspace-runtime.ts` | `worktree.*` socket API |
| Diffs and checkpoints | rewind only | `CheckpointStore` | `workspace/changes` summaries | `plugin-workspace-diff` | none |
| Terminals and processes | none | `terminal/Manager.ts` | `ctx.terminals`, `ctx.shell` | `process` adapter | PTY panes |
| Cost | context gauge, usage-limit parking | `UsageService` | `ctx.tokenMeter` | `cost_events`, budgets | none |
| Plugin platform | slots, list slots, pages, leases, reload transaction | none | cordis services, slots, Typert RPC | worker processes, manifest, SDK | manifest and CLI |
