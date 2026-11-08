# dia org — PRD

## Problem Statement

William is dia's developer and its first user. dia runs agents for his registered projects in the background (`docs/prds/agent-os.md`), but every agent is one he started by hand, in one tab, with a prompt he wrote. He wants to give dia an objective, such as "ship the plugin marketplace by December", and have a team of agents plan and do the work while he reviews the plan's direction. Today dia has no objectives, no tasks beyond each agent's `TodoWrite` list, no limit on how many agents run, no memory shared between agents, and no way for agents to improve the harness from what they learn except the planned `meta_propose` tool (#17). Reviewing a plan as a list of tasks does not work at scale: a wrong plan starts with one wrong choice, and fourteen tasks hide which one it was.

## Goals / Success Criteria

1. A request the user types in a router session becomes an objective in the right project, routed `direct` to one worker or `plan` to a planning issue, with no action from the user other than assigning the planning issue, accepting the issues it proposes in Triage, and reviewing the decision path of a `plan` objective. Every objective creates a planning issue (ADR-0069); the agent assigned to it breaks the objective into `triage` issues with `create_issue`.
2. The decision path of an objective lists every decision its tasks depend on. In testing, each task in an approved plan traces to at least one decision on the path.
3. Cutting the decision path at a decision resets the tasks that depend on it, discards the tasks that depend only on later decisions, leaves other tasks untouched, and produces a new plan from it that follows the user's guidance, in 100% of cuts during testing. A completed decision cannot be cut.
4. A decision an agent records during the work pauses that agent until the user accepts it or cuts there, with zero agents continuing past an unreviewed decision during testing.
5. With an overall cap of N and a job title with M hired agents, no more than N hired agents and no more than M agents of that job title run at once, across at least 50 tasks in testing. Ad-hoc tabs are never queued or counted.
6. Finishing a `work` issue creates a retro issue, and a retro reads every transcript saved against the issue it reviews (ADR-0069 amends ADR-0035 and ADR-0064: the finished issue does not wait for its retro).
7. A long-term memory entry written by a retro in one task is available to the next agent that starts in that entry's scope.
8. Each memory entry shows how often and how recently retros cited it, and an entry not cited for a configurable period is marked stale.
9. A harness change from an agent applies at once or waits in the decision queue according to the user's tier for its change type, with zero exceptions during testing, and every change that applied at once can be reverted from the change log.
10. A routine runs at its configured time while dia is running, in 100% of scheduled runs during testing.
11. Every active session of a hired agent can be opened from the agent overview, and a `steer` message sent to it interrupts the turn and runs next, in 100% of attempts during testing.
12. A hired agent starts in `auto` whenever its model supports `auto` and Claude Code settings do not disable it, and never starts in `bypassPermissions` unless its job title or hire opts in, in 100% of sessions during testing.
13. The worker or planning issue of a routed objective receives the user's words unchanged, in 100% of routed objectives during testing.
14. All `docs/prds/agent-os.md` success criteria still hold. Its goals 6 and 7 are read with `propose_change` in place of `meta_propose` (ADR-0036).

## User Stories

1. As a user, I want one org that works across all my projects so that a hired agent can take the next task in any project.
2. As a user, I want to hire an agent by choosing a job title and an optional name so that my team has the skills the work needs.
3. As a user, I want to hire more agents of a job title so that more agents of that job title can run at once.
4. As a user, I want to set an overall cap on running hired agents so that dia stays within my machine's and my plan's limits.
5. As a user, I want ad-hoc tabs to keep working as they do today, outside the caps, so that I can always ask a quick question.
6. As a user, I want built-in job titles (Product manager, Software engineer, Quality engineer, Business analyst, UI/UX designer, Team lead, Technical lead) and a built-in router that I can disable, copy and edit so that I can start without writing job titles and change them later.
7. As a user, I want a job title to carry an optional allow/ask/deny permission list, where an empty list allows every tool, so that each job title has the access its work needs.
8. As a user, I want to create an objective in a project and either assign it to a hired agent or leave it unassigned, so that its planning issue waits for me to assign it, and I can start work without the router.
9. As a user, I want agents to break an objective into issues and sub-issues, and to accept or decline each proposed issue in Triage, so that I do not plan the work myself.
10. As a user, I want to review an objective's plan as a path of decisions, each with the alternatives the agent rejected and how confident it was, so that I can see where the plan will go without reading every task.
11. As a user, I want to cut the decision path at a decision and add guidance, or pick a rejected alternative, so that the team re-plans from that point.
12. As a user, I want a decision an agent makes during the work to wait for my review so that the work never moves past a decision I have not seen.
13. As a user, I want one decision queue for plans, new decisions, `ask` permissions and harness changes so that I have one place to unblock agents.
14. As a user, I want every session that works on a task to save its transcript against that task so that the task's history is complete.
15. As a user, I want each task's sessions to share a scratchpad so that a resumed session or a reviewer sees what the earlier session found.
16. As a user, I want a retro issue, assigned to the agent I pick, to read the finished issue's transcripts and write long-term memory, so that what one agent learns reaches the next.
17. As a user, I want long-term memory scoped to a project, the environment, or a job title so that each agent loads only what applies to it.
18. As a user, I want to see how often and how recently each memory entry was cited by a retro so that I can find stale entries.
19. As a user, I want to browse memory, edit it by hand, or ask the meta agent to edit it, and to run the meta agent from a routine to tidy it, so that memory stays correct.
20. As a user, I want to create routines, such as a daily status summary at 06:00, so that recurring work happens without me starting it.
21. As a user, I want workflows that set a sequence of steps with a job title per step, with built-ins I can disable or copy, so that work follows the process I choose.
22. As a user, I want dia to compute org KPIs (tasks done, cost per task, decisions cut, time waiting on me, waste per task) so that I can see how well the org works.
23. As a user, I want to write objective KPIs with a target, measured by the assigned agent, so that I can see progress toward each objective.
24. As a user, I want agents to propose changes to memory, skills, job titles, workflows, tools and plugins, with the evidence that motivated each change, so that the harness improves from real runs.
25. As a user, I want to set per change type whether an agent's harness change applies at once or waits for my approval so that I control the risk.
26. As a user, I want a tool an agent builds to be a plugin that adds to dia's tool set so that it follows the same rules as every other plugin.
27. As a user, I want to open a hired agent's active session, read what it is doing, and send it a queued or steering message so that I can correct a task while it runs.
28. As a user, I want to tell a router agent what I want in my own words, in any number of router sessions outside any project, so that it hands the work to the right agent in the right project without me filling in a form.
29. As a user, I want the router to send a one-step request straight to a worker and a multi-step one to a planning issue so that small work starts without a plan review.
30. As a user, I want the router session I asked in to tell me when the work needs me or is done, linking to the decision queue, so that I learn about it where I asked.
31. As a user, I want hired agents to run in `auto` mode where my model and settings allow it so that they stop for me only when the classifier cannot decide.
32. As a user, I want `bypassPermissions` to run only for a job title or hire I opted in so that no agent runs without checks unless I chose it.

## Decisions

| Area | Decision | Recorded in |
| --- | --- | --- |
| Org scope | One org across every registered project; objectives belong to a project | ADR-0033 |
| Hiring | A hired agent has a job title and an optional name; hiring another agent of a job title raises that job title's concurrency by one | ADR-0033, ADR-0064 |
| Caps | The overall cap is set by the user. Retro and planning issue sessions count toward the caps. Ad-hoc tabs and router sessions never count | ADR-0033, ADR-0053 |
| Slots | A hired agent holds a slot while its turn, or background work its turn started, runs. Waiting on the user frees it; the user's answer starts the agent before waiting tasks, up to one over the cap | ADR-0033 |
| Queue order | When a cap is full, `todo` issues with an assignee start by objective priority, then oldest first | ADR-0033 |
| Router | Built in, never hired or counted. Any number of router sessions in the `Assistant` rail group. Passes the user's words on unchanged with a routing note of at most 30 words; never plans. Routes `direct` to one worker or `plan` to a planning issue | ADR-0053, ADR-0064 |
| Unassigned objectives | Every objective creates a planning issue. With an assignee the dispatcher starts it at once; without one it waits until the user assigns it. There is no objective watcher setting | ADR-0053, ADR-0064, ADR-0069 |
| Permission modes | Hired agents start in `auto` when the model and settings allow it, else in `bypassPermissions` if the job title or hire opts in, else in `default`. Router sessions run in `dontAsk` | ADR-0054 |
| Plan review | Every objective's plan, assigned or not, goes through decision path review before work starts. Tasks created by a routine and `direct` objectives from the router skip it | ADR-0034, ADR-0053 |
| Cutting | A completed decision cannot be cut; cutting an in-progress decision requires confirming its work is discarded. Dependent tasks reset to the commit recorded with the decision, tasks that depend only on later decisions are discarded, others are untouched; discarded commits stay on a backup ref | ADR-0034 |
| Steering against a decision | When a message contradicts a recorded decision, the agent records a new decision marked as made by the user | ADR-0034 |
| Planning and retro | Planning and retro are kinds of issue. The user picks the hired agent of each. dia hires nobody on first run; finishing a `work` issue moves it to `done` and creates its retro issue | ADR-0064, ADR-0069 |
| Steering tasks | A hired agent's active session opens like a tab: live transcript and the composer with `queue` and `steer` (`docs/designs/message-queue-and-steer.md`) | ADR-0033 |
| Live decisions | A decision recorded during the work pauses its agent until the user accepts it or cuts there | ADR-0034 |
| Memory | Scratchpad per task; long-term memory in project, environment and job title scopes; the retro task writes long-term memory by the memory tier and cites the entries each task used; staleness counts citations | ADR-0035 |
| Self-improvement | Change types are tiered; the user sets each tier. Agents change workflows and job titles through `propose_change` like any other harness change | ADR-0036 |

## Agent tools

dia serves these tools from the Host's in-process MCP server (`src/host/session/dia-tools.ts`). A job title's allow/ask/deny list and the session's permission mode apply to them as to any tool (ADR-0069). A plugin can register more.

| Tool | Purpose | Called by |
| --- | --- | --- |
| `objectives_read`, `objective_create`, `objective_attach`, `objective_stop` | Read objectives across projects; create one with the user's words, a routing note and a route; pass a message to an objective's agents; stop one | router |
| `create_issue`, `update_issue`, `comment_issue` (served from `plugins/org/issue-tools.ts`) | Add a `triage` issue or sub-issue to the session's objective; change an issue's title, description, or (own issue only) started status; comment on an issue | the agent of a planning issue; any hired agent |
| `record_decision` | Add a decision, its rejected alternatives and a confidence to the decision path | any agent |
| `scratchpad_read`, `scratchpad_write` | Read and write the current task's scratchpad | agents on the task |
| `memory_search`, `memory_write` | Read long-term memory (recorded as a read); write it | all agents read; the agent of a retro issue writes |
| `report_kpi` | Report an objective KPI's measured value | the agent assigned to the objective |
| `propose_change` | Propose a harness change with the transcripts that motivated it | the agent of a retro issue, meta agents |
| `plugin_override`, `plugin_reload`, `plugin_clear_override` | Build and load plugins (`docs/prds/plugin-platform.md`) | agents working on dia |

## Testing Decisions

**Approach:** Automated tests cover logic that can be checked in isolation: the scheduler (overall cap, per-job-title caps, queue order, ad-hoc tabs ignored), task and objective state transitions (a task cannot complete before its retro), decision path construction and cutting (which tasks and commits are discarded), the start permission mode for each combination of `autoMode`, disabled modes and bypass opt-in, slot release and the one-over-cap resume, memory scope selection for a new session, memory citation counts and staleness, the tier rule that routes a harness change to apply or to the queue, routine schedule evaluation with Effect's `TestClock`, and permission list evaluation for a job title. Manual testing on the installed build covers a full objective: a request in a router session routed `direct` and another routed `plan`, an unassigned objective planned by the agent the user assigns, a cut with guidance, a live decision that pauses an agent, a retro that writes memory, and that memory loaded into an agent in a later task.

**Constraints:** No production or customer data is involved. Testing runs on the developer's machine against his local Claude Code installation. Transcripts used in testing can contain local paths and command output.

## Out of Scope

- Adapters for agent harnesses other than Claude Code (roadmap; ADR-0029 allows more adapters)
- Built-in routines; dia ships none
- Objective KPIs read from an external source by a command or URL, or entered by hand
- A memory scope per hired agent; long-term memory is shared by scope only
- Agents that keep running after dia quits (roadmap in `docs/prds/agent-os.md`)
- Users other than William (roadmap); defaults must still not assume his machine or configuration

## Additional Notes

This PRD extends `docs/prds/agent-os.md` and builds on the plugin platform (`docs/prds/plugin-platform.md`). Every feature in it is a built-in plugin (ADR-0019). Its plan is `docs/plans/2026-10-28-org.md`. Its decisions are ADR-0033 (org of hired role agents), ADR-0034 (decision path and decision queue), ADR-0035 (task memory and retros), ADR-0036 (tiered self-improvement, which amends ADR-0025), ADR-0053 (router role), ADR-0054 (permission modes for hired agents) and ADR-0064 (job titles and task kinds). The router follows DeepSeek's dsh-superagent prototype (<https://github.com/deepseek-ai/dsh-superagent-prototype>), which separates a session that only routes from sessions that do the work. The decision path and decision queue screens are designed with `/impeccable` against `DESIGN.md` before they are wired to real data.

## Open Questions

- How a hired agent's sessions appear in the agent overview: as tabs in the task's project labelled with the agent's name, or in a separate org group.
- The period after which an uncited memory entry is marked stale, and whether it differs by scope.
- How a job title selects a model, and whether the model is a job title setting or a hire setting.
