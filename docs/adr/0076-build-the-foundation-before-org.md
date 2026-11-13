---
status: accepted
date: 2026-11-13
decision-makers: William Pei
---

# Build ten foundation capabilities as plugins before more org work, freeze the org plugin, then rewrite it on them

## Context and Problem Statement

The org plugin builds generic agent capabilities for itself, and later changes move them out: MCP configuration (#213, then #226), job titles (#210, then #228), objectives and issues (#214 and #216, then #231), worktrees (#232). ADR-0053, ADR-0064, ADR-0069, ADR-0071, ADR-0072 and ADR-0073 amend the org decisions in a chain. The org, issues and worktrees plugins total 12,133 lines of non-test code, against 3,977 for `claude-code` (line counts from `wc -l`, 2026-11-13). t3code, deepseek-harness, paperclip and herdr each provide headless runs, requests as data, agent-to-agent messaging and tool contribution as core capabilities; dia provides none of these to plugins. In what order should dia build capabilities, and what happens to org meanwhile?

## Decision Drivers

* A feature plugin is a composition of foundation capabilities and contains no generic agent machinery.
* No capability is built inside a feature plugin and moved out later.
* Work on the foundation does not maintain code that the foundation replaces.

## Considered Options

* Build the foundation, freeze org, then rewrite org
* Extract one capability at a time from org and keep org working after every change
* Rewrite the plugin platform and the foundation together

## Decision Outcome

Chosen option: "Build the foundation, freeze org, then rewrite org", because org's generic code (`dispatcher.ts`, `scheduler.ts`, `session-tools.ts`, the `PendingPermission` table) is replaced rather than reshaped, and the renderer shell and `claude-code` adapter stay as they are. The plugin platform gains only the additions the foundation needs: plugin data migrations (ADR-0078) and cross-plugin renderer calls (ADR-0074).

The foundation is ten capabilities, each a plugin, built in the order of `docs/plans/2026-11-13-foundation.md`:

| Capability | Requirement | Reference implementation |
| --- | --- | --- |
| Runs and their event log (ADR-0074) | — | t3code `ProviderSessionManager`; deepseek-harness `ctx.agents`, `packages/core/session` |
| Requests as data and an inbox | `dia-inbox` replaces the `decision-queue` plugin planned in ADR-0034 | t3code `RuntimeRequest`; paperclip `services/attention.ts` |
| Tool registry (ADR-0075) | — | deepseek-harness `ctx.tools`; t3code `mcp/toolkits` |
| Run queue | The limit counts runs with a turn in progress or background tasks, not runs that exist. A caller can set a limit per key (for example one run per hire). A run whose request the user answered resumes ahead of queued runs. | t3code `Scheduler`; paperclip `agent_wakeup_requests`; `plugins/org/scheduler.ts` |
| Agent-to-agent send, wait and delegate | For features that need run-to-run messaging. Org hands work over through issues (ADR-0069, ADR-0071), not through these tools. | t3code `delegate_task`, `t3_thread_send`; herdr `agent.prompt`, `agent.wait` |
| Schedules: interval and cron runs | Replaces the `routines` plugin planned in ADR-0072 | t3code `ScheduledTaskService`; paperclip `routines` |
| Git operations: status, diff, log, branch, commit, push, worktrees | — | t3code `vcs/VcsDriver.ts`, `git/GitManager.ts` |
| Diffs and checkpoints per run | — | t3code `checkpointing/CheckpointStore.ts` |
| Terminals and processes | — | t3code `terminal/Manager.ts`; deepseek-harness `ctx.terminals` |
| Cost per run | — | paperclip `cost_events`; t3code `usage/UsageService` |

The org plugin is frozen until the foundation is complete: its code moves from `plugins/org` to `archive/org`, which `tsconfig`, the renderer build and the plugin loader do not include. Its data folder (`<userData>/plugins/org`: `data.db` and the `assistant` folder) stays on disk for the rewrite. The rewritten org composes issues, hires and routing over the foundation and contains no session runner, permission queue or scheduler.

This ADR amends ADR-0034 and ADR-0072 as stated in the capability table.

### Consequences

* Good, because each capability is designed once, as a plugin other features use.
* Good, because no foundation change has to keep `plugins/org/dispatcher.ts` compiling.
* Bad, because org is unavailable until the foundation is complete.
* Bad, because the step order puts the run plugins early, and they change chat, the most-used feature.

## Pros and Cons of the Options

### Extract one capability at a time from org and keep org working after every change

* Good, because org stays usable and each change is small.
* Bad, because each extraction keeps the org-shaped interface it was built with, which is the pattern in #213→#226, #210→#228 and #214→#231.

### Rewrite the plugin platform and the foundation together

* Good, because the plugin platform (leases, `whenProvided`, the reload transaction) can change to fit runs.
* Bad, because chat, rewind and worktrees break while two layers change at once.

## More Information

* Before each of the schedules, checkpoints and terminals steps, its design checks the overlap the 2026-11-13 review found: `ctx.activities` (`src/shared/plugin/api.ts`), the Agent SDK's file rewind (ADR-0045), and the native modules a PTY needs (ADR-0042).
* The issue statuses and vocabulary the rewritten org uses are in `docs/glossary.md`.
