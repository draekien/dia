# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Register

product

## Users

William, dia's developer and its first user, on his own Windows desktop machine. He drives local Claude Code installations through dia, including using dia to develop dia. He starts several agents across several projects, leaves them to work, and returns to an agent only when it needs his input or has failed. He watches the work in progress less and less often, and wants to set objectives for a team of agents instead of starting each agent himself.

Other Claude Code users are on the roadmap. dia's defaults must not assume William's machine, paths, projects or Claude Code configuration.

## Product Purpose

dia is a desktop app that runs agents for a user's projects, the way an operating system runs processes: agents work in the background, dia tells the user when an agent needs input or has failed, and the user can see what every agent is doing without opening it.

dia is also a meta harness: a harness that orchestrates agent harnesses. The user runs an org of hired agents. The user sets objectives, agents break them into tasks, and the user reviews and steers the decisions the agents make. Agents improve the harness they run in: they write memory, skills, workflows, tools and plugins.

Success means William starts agents in dia, closes or ignores their tabs, and learns about every permission request, question, failure and decision that needs him from dia, with no missed or false notifications. It also means objectives reach their KPIs, and the changes agents make to the harness reduce waste in his agents' runs over time.

## Positioning

dia combines four things that Claude Desktop and the Claude Code CLI do not:

- Agents for many projects run in one app, keep running while out of view, and report back when they are blocked.
- An org of hired agents works toward the user's objectives. The user reviews each objective's plan as a path of decisions, and cuts the path at a wrong decision to have the team re-plan from there (`docs/prds/org.md`).
- The harness improves itself. Every completed task ends with a retro that writes long-term memory, and agents propose changes to roles, workflows, tools and plugins (ADR-0034, ADR-0035).
- Every dia feature is a plugin that can be changed while dia runs (ADR-0019, `docs/prds/plugin-platform.md`). Agent harnesses are adapter plugins (ADR-0029). Claude Code is the only adapter.

## Operating Context

- **Projects.** The user registers directories with dia. A directory does not have to be a git repo. Worktree features apply only to projects that are git repos.
- **Tabs.** Each agent runs in its own tab inside a project. One tab is visible at a time. Agents in tabs that are not visible keep running.
- **Ad-hoc tabs.** The user can open a tab and chat with an agent directly, as before the org existed. An ad-hoc tab does not count toward any concurrency cap.
- **Org.** One org spans every registered project. The user hires agents: each hired agent has a role and an optional name. Hiring another agent of a role lets one more agent of that role run at once. An overall cap, set by the user, limits how many hired agents run at once (ADR-0032).
- **Roles.** dia ships the roles planner, engineer, reviewer, researcher and retro. The user can disable, copy and edit them, and create new roles. A role has instructions, skills, MCP servers and an optional allow/ask/deny permission list; an empty list allows every tool.
- **Objectives and tasks.** An objective belongs to a project and has objective KPIs. The user assigns an objective to a hired agent, or leaves it unassigned for the agent the user set to watch objectives (by default a planner). Agents break objectives into tasks and sub-tasks.
- **Decision path.** Agents record each choice they make about how to reach an objective. The user reviews the path before work starts, and can cut it at a wrong decision and add guidance; the team re-plans from that decision. A new decision made during the work pauses its agent until the user accepts it or cuts there (ADR-0033).
- **Steering tasks.** The user can open any hired agent's active session from the agent overview, read its live transcript, and send it a message that waits for the turn to end (`queue`) or interrupts it (`steer`), as in an ad-hoc tab.
- **Decision queue.** One list of everything that waits on the user: plans to review, new decisions, `ask` permissions and harness changes.
- **Memory.** Each task has a scratchpad its sessions share. Long-term memory has project, environment and role scopes. dia records each read of a memory entry, so stale entries can be found (ADR-0034).
- **Routines and workflows.** A routine is a recurring task the user creates, for example "every day at 06:00, send me a summary of project status". A workflow is a sequence of steps with a role per step. dia ships built-in workflows that the user can disable or copy, and ships no routines.
- **Window.** Agents keep running while the window is minimised or another app is focused. Closing the window quits dia and stops every agent; the agents resume from their saved sessions on the next start.
- **Notifications.** An agent in a tab that is not visible, or in a window that is minimised or not focused, raises an OS notification when it requests a permission, asks a question, or fails. A finished turn only badges its tab. Clicking a notification opens that agent's tab.
- **Agent overview.** A left sidebar listing every agent in every project, which is also how the user switches tabs. Each agent has its status and one activity line: the `in_progress` item of its latest `TodoWrite`, or its last tool call when it has no task list.
- **Meta project.** A git repo that dia creates and loads into every agent it starts. A meta agent can read and write every registered project and its transcripts. The user starts meta agents, or runs them from a routine. The user may push the meta repo to a remote; dia refuses a push that contains a secret.
- **Daily use.** William runs dia's own development in dia, next to his other projects.

## Capabilities and Constraints

- The agent session is owned by the plugin kernel, and every other feature is a plugin (ADR-0019).
- Agents stop when dia quits. Keeping them running after quit is on the roadmap.
- dia measures outcomes and waste. Org KPIs are computed by dia (tasks done, cost per task, decisions cut, time waiting on the user, waste per task). Objective KPIs are written by the user and measured by the agent assigned to the objective. Waste is no-op tool calls, tool calls that return errors, and expensive tool calls.
- The meta project's changes reach agents through the Agent SDK's `plugins` option (skills, agents, hooks, commands, MCP servers) and appended system prompt instructions.
- Harness changes from agents apply by risk tier, which the user configures per change type. By default, text that agents read (memory, skills, role instructions) applies at once and can be reverted from a change log; changes to what runs (workflows, tools, plugins, hooks, role permissions) wait in the decision queue (ADR-0035).
- Split panes are no longer a product feature. The tab layout replaces the split-pane workspace in `docs/prds/mvp.md`.
- Out of scope: a notice board for agents to leave notes for each other. It was considered and dropped, because worktrees, task scratchpads, the decision path and the agent overview cover the same needs.
- Roadmap: keeping dia and its agents running in the system tray when the window closes; agents that keep running after dia quits; adapters for agent harnesses other than Claude Code; an approval step that copies parts of the meta repo into the user's `~/.claude` configuration; other users.

## Brand Commitments

- The name is `dia`, written in lower case.
- Polished consumer desktop app: the craft level of a well-made native app, not a bare-bones developer tool.
- Not a raw terminal-multiplexer look, and not a generic AI chat SaaS look.
- Attention signals are rare and reserved for agent state, so that a signal means the user is needed.

## Evidence on Hand

- dia's own repository and its use for dia's development are the only usage evidence.
- No other users, testimonials or metrics exist. Do not invent any.

## Product Principles

1. **Interrupt only when needed.** dia asks for the user's attention only when an agent is blocked on the user: a permission request, a question, a failure, or a decision in the decision queue. Everything else is visible on request.
2. **Status without opening.** The user can tell what any agent is doing, and whether it needs them, from the agent overview, without opening its tab.
3. **Background by default.** An agent that is not on screen keeps working, and nothing in dia requires watching it.
4. **Steer decisions, not tasks.** The user reviews the decisions an objective's plan depends on, not its task list, and corrects a plan by cutting it at the first wrong decision.
5. **Improvements are reviewable.** Every change that affects every agent, from an agent, the meta project or a plugin, is recorded and can be reverted. Changes to what runs wait for the user's approval unless the user has set that change type to apply at once.
6. **Fast under real use.** dia drives real development work, including its own, so latency is part of the design.

## Accessibility & Inclusion

WCAG AA contrast and full keyboard navigation. Status animations honour reduced-motion settings. OS notifications carry the agent's project, tab name and the reason, so that the notification text alone identifies the agent without the app open.
