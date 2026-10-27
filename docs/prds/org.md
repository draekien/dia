# dia org — PRD

## Problem Statement

William is dia's developer and its first user. dia runs agents for his registered projects in the background (`docs/prds/agent-os.md`), but every agent is one he started by hand, in one tab, with a prompt he wrote. He wants to give dia an objective, such as "ship the plugin marketplace by December", and have a team of agents plan and do the work while he reviews the plan's direction. Today dia has no objectives, no tasks beyond each agent's `TodoWrite` list, no limit on how many agents run, no memory shared between agents, and no way for agents to improve the harness from what they learn except the planned `meta_propose` tool (#17). Reviewing a plan as a list of tasks does not work at scale: a wrong plan starts with one wrong choice, and fourteen tasks hide which one it was.

## Goals / Success Criteria

1. An objective left unassigned is picked up by the agent set to watch objectives and broken into tasks, with no action from the user other than reviewing the decision path.
2. The decision path of an objective lists every decision its tasks depend on. In testing, each task in an approved plan traces to at least one decision on the path.
3. Cutting the decision path at a decision resets the tasks that depend on it, discards the tasks that depend only on later decisions, leaves other tasks untouched, and produces a new plan from it that follows the user's guidance, in 100% of cuts during testing. A completed decision cannot be cut.
4. A decision an agent records during the work pauses that agent until the user accepts it or cuts there, with zero agents continuing past an unreviewed decision during testing.
5. With an overall cap of N and a role with M hired agents, no more than N hired agents and no more than M agents of that role run at once, across at least 50 tasks in testing. Ad-hoc tabs are never queued or counted.
6. No task reaches `completed` without a retro that read every transcript saved against it.
7. A long-term memory entry written by a retro in one task is available to the next agent that starts in that entry's scope.
8. Each memory entry shows how often and how recently retros cited it, and an entry not cited for a configurable period is marked stale.
9. A harness change from an agent applies at once or waits in the decision queue according to the user's tier for its change type, with zero exceptions during testing, and every change that applied at once can be reverted from the change log.
10. A routine runs at its configured time while dia is running, in 100% of scheduled runs during testing.
11. Every active session of a hired agent can be opened from the agent overview, and a `steer` message sent to it interrupts the turn and runs next, in 100% of attempts during testing.
12. All `docs/prds/agent-os.md` success criteria still hold. Its goals 6 and 7 are read with `propose_change` in place of `meta_propose` (ADR-0036).

## User Stories

1. As a user, I want one org that works across all my projects so that a hired agent can take the next task in any project.
2. As a user, I want to hire an agent by choosing a role and an optional name so that my team has the skills the work needs.
3. As a user, I want to hire more agents of a role so that more agents of that role can run at once.
4. As a user, I want to set an overall cap on running hired agents so that dia stays within my machine's and my plan's limits.
5. As a user, I want ad-hoc tabs to keep working as they do today, outside the caps, so that I can always ask a quick question.
6. As a user, I want built-in roles (planner, engineer, reviewer, researcher, retro) that I can disable, copy and edit so that I can start without writing roles and change them later.
7. As a user, I want a role to carry an optional allow/ask/deny permission list, where an empty list allows every tool, so that each role has the access its work needs.
8. As a user, I want to create an objective in a project and either assign it to a hired agent or leave it unassigned so that the agent I set to watch objectives delegates it.
9. As a user, I want agents to break an objective into tasks and sub-tasks so that I do not plan the work myself.
10. As a user, I want to review an objective's plan as a path of decisions, each with the alternatives the agent rejected and how confident it was, so that I can see where the plan will go without reading every task.
11. As a user, I want to cut the decision path at a decision and add guidance, or pick a rejected alternative, so that the team re-plans from that point.
12. As a user, I want a decision an agent makes during the work to wait for my review so that the work never moves past a decision I have not seen.
13. As a user, I want one decision queue for plans, new decisions, `ask` permissions and harness changes so that I have one place to unblock agents.
14. As a user, I want every session that works on a task to save its transcript against that task so that the task's history is complete.
15. As a user, I want each task's sessions to share a scratchpad so that a resumed session or a reviewer sees what the earlier session found.
16. As a user, I want a retro to run before a task completes, read the task's transcripts and write long-term memory, so that what one agent learns reaches the next.
17. As a user, I want long-term memory scoped to a project, the environment, or a role so that each agent loads only what applies to it.
18. As a user, I want to see how often and how recently each memory entry was cited by a retro so that I can find stale entries.
19. As a user, I want to browse memory, edit it by hand, or ask the meta agent to edit it, and to run the meta agent from a routine to tidy it, so that memory stays correct.
20. As a user, I want to create routines, such as a daily status summary at 06:00, so that recurring work happens without me starting it.
21. As a user, I want workflows that set a sequence of steps with a role per step, with built-ins I can disable or copy, so that work follows the process I choose.
22. As a user, I want dia to compute org KPIs (tasks done, cost per task, decisions cut, time waiting on me, waste per task) so that I can see how well the org works.
23. As a user, I want to write objective KPIs with a target, measured by the assigned agent, so that I can see progress toward each objective.
24. As a user, I want agents to propose changes to memory, skills, roles, workflows, tools and plugins, with the evidence that motivated each change, so that the harness improves from real runs.
25. As a user, I want to set per change type whether an agent's harness change applies at once or waits for my approval so that I control the risk.
26. As a user, I want a tool an agent builds to be a plugin that adds to dia's tool set so that it follows the same rules as every other plugin.
27. As a user, I want to open a hired agent's active session, read what it is doing, and send it a queued or steering message so that I can correct a task while it runs.

## Decisions

| Area | Decision | Recorded in |
| --- | --- | --- |
| Org scope | One org across every registered project; objectives belong to a project | ADR-0033 |
| Hiring | A hired agent has a role and an optional name; hiring another agent of a role raises that role's concurrency by one | ADR-0033 |
| Caps | The overall cap is set by the user. Retro and planner sessions count toward the caps. Ad-hoc tabs never count | ADR-0033 |
| Queue order | When a cap is full, waiting tasks start by objective priority, then oldest first | ADR-0033 |
| Unassigned objectives | Picked up by the role the user sets to watch objectives; the default is the built-in planner | ADR-0033 |
| Plan review | Every objective's plan, assigned or not, goes through decision path review before work starts. Tasks created by a routine skip it | ADR-0034 |
| Cutting | A completed decision cannot be cut; cutting an in-progress decision requires confirming its work is discarded. Dependent tasks reset to the commit recorded with the decision, tasks that depend only on later decisions are discarded, others are untouched; discarded commits stay on a backup ref | ADR-0034 |
| Steering against a decision | When a message contradicts a recorded decision, the agent records a new decision marked as made by the user | ADR-0034 |
| Required roles | On first run dia hires one objective watcher and one `retro`; the user can dismiss them, and work then waits with a warning | ADR-0033 |
| Steering tasks | A hired agent's active session opens like a tab: live transcript and the composer with `queue` and `steer` (`docs/designs/message-queue-and-steer.md`) | ADR-0033 |
| Live decisions | A decision recorded during the work pauses its agent until the user accepts it or cuts there | ADR-0034 |
| Memory | Scratchpad per task; long-term memory in project, environment and role scopes; the retro writes long-term memory by the memory tier and cites the entries each task used; staleness counts citations | ADR-0035 |
| Self-improvement | Change types are tiered; the user sets each tier. Agents change workflows and roles through `propose_change` like any other harness change | ADR-0036 |

## Agent tools

dia serves these tools from the Host's in-process MCP server (`src/host/session/dia-tools.ts`). A role's allow/ask/deny list applies to them as to any tool. A plugin can register more.

| Tool | Purpose | Called by |
| --- | --- | --- |
| `create_task`, `update_task` | Create and update tasks and sub-tasks of an objective | planner; any agent for sub-tasks |
| `record_decision` | Add a decision, its rejected alternatives and a confidence to the decision path | any agent |
| `scratchpad_read`, `scratchpad_write` | Read and write the current task's scratchpad | agents on the task |
| `memory_search`, `memory_write` | Read long-term memory (recorded as a read); write it | all agents read; retro writes |
| `report_kpi` | Report an objective KPI's measured value | the agent assigned to the objective |
| `propose_change` | Propose a harness change with the transcripts that motivated it | retro, meta agents |
| `plugin_override`, `plugin_reload`, `plugin_clear_override` | Build and load plugins (`docs/prds/plugin-platform.md`) | agents working on dia |

## Testing Decisions

**Approach:** Automated tests cover logic that can be checked in isolation: the scheduler (overall cap, per-role caps, queue order, ad-hoc tabs ignored), task and objective state transitions (a task cannot complete before its retro), decision path construction and cutting (which tasks and commits are discarded), memory scope selection for a new session, memory citation counts and staleness, the tier rule that routes a harness change to apply or to the queue, routine schedule evaluation with Effect's `TestClock`, and permission list evaluation for a role. Manual testing on the installed build covers a full objective: an unassigned objective planned by the planner, a cut with guidance, a live decision that pauses an agent, a retro that writes memory, and that memory loaded into an agent in a later task.

**Constraints:** No production or customer data is involved. Testing runs on the developer's machine against his local Claude Code installation. Transcripts used in testing can contain local paths and command output.

## Out of Scope

- Adapters for agent harnesses other than Claude Code (roadmap; ADR-0029 allows more adapters)
- Built-in routines; dia ships none
- Objective KPIs read from an external source by a command or URL, or entered by hand
- A memory scope per hired agent; long-term memory is shared by scope only
- Agents that keep running after dia quits (roadmap in `docs/prds/agent-os.md`)
- Users other than William (roadmap); defaults must still not assume his machine or configuration

## Additional Notes

This PRD extends `docs/prds/agent-os.md` and builds on the plugin platform (`docs/prds/plugin-platform.md`). Every feature in it is a built-in plugin (ADR-0019). Its plan is `docs/plans/2026-10-28-org.md`. Its decisions are ADR-0033 (org of hired role agents), ADR-0034 (decision path and decision queue), ADR-0035 (task memory and retros) and ADR-0036 (tiered self-improvement, which amends ADR-0025). The decision path and decision queue screens are designed with `/impeccable` against `DESIGN.md` before they are wired to real data.

## Open Questions

- When a hired agent holds a slot: only while a session of its task is running a turn, or for the whole time it is assigned an open task, including time waiting in the decision queue.
- How a hired agent's sessions appear in the agent overview: as tabs in the task's project labelled with the agent's name, or in a separate org group.
- Where long-term memory is stored: in the meta repo, so that each write is a git commit, or in a store under `userData`.
- The period after which an uncited memory entry is marked stale, and whether it differs by scope.
- How a role selects a model, and whether the model is a role setting or a hire setting.
