# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Register

product

## Users

William, dia's developer and its first user, on his own Windows desktop machine. He drives local Claude Code installations through dia, including using dia to develop dia. He starts several agents across several projects, leaves them to work, and returns to an agent only when it needs his input or has failed. He watches the work in progress less and less often.

Other Claude Code users are on the roadmap. dia's defaults must not assume William's machine, paths, projects or Claude Code configuration.

## Product Purpose

dia is a desktop app that runs Claude Agent SDK agents for a user's projects, the way an operating system runs processes: agents work in the background, dia tells the user when an agent needs input or has failed, and the user can see what every agent is doing without opening it.

Success means William starts agents in dia, closes or ignores their tabs, and learns about every permission request, question and failure from dia's notifications, with no missed or false notifications. It also means the meta project's changes reduce waste in his agents' runs over time.

## Positioning

dia combines three things that Claude Desktop and the Claude Code CLI do not:

- Agents for many projects run in one app, keep running while out of view, and report back when they are blocked.
- A meta project, which is a git repo owned by dia, applies to every agent dia starts. Agents propose improvements to it, a meta agent turns the proposals into changes, and the user approves each merge.
- Every dia feature is a plugin that can be changed while dia runs (ADR-0019, `docs/prds/plugin-platform.md`).

## Operating Context

- **Projects.** The user registers directories with dia. A directory does not have to be a git repo. Worktree features apply only to projects that are git repos.
- **Tabs.** Each agent runs in its own tab inside a project. One tab is visible at a time. Agents in tabs that are not visible keep running.
- **Window and tray.** Closing the window keeps dia and its agents running in the system tray. Quitting from the tray stops every agent; the agents resume from their saved sessions on the next start.
- **Notifications.** An agent in a tab that is not visible, or in a hidden window, raises an OS notification when it requests a permission, asks a question, or fails. A finished turn only badges its tab. Clicking a notification opens that agent's tab.
- **Agent overview.** A list of every agent in every project, each with its status and one activity line: the `in_progress` item of its latest `TodoWrite`, or its last tool call when it has no task list.
- **Meta project.** A git repo that dia creates and loads into every agent it starts. A meta agent can read and write every registered project and its transcripts. The user starts meta agents. The user may push the meta repo to a remote; dia refuses a push that contains a secret.
- **Daily use.** William runs dia's own development in dia, next to his other projects.

## Capabilities and Constraints

- The agent session is owned by the plugin kernel, and every other feature is a plugin (ADR-0019).
- Agents stop when dia quits. Keeping them running after quit is on the roadmap.
- The meta project measures waste in the user's agent environment: no-op tool calls, tool calls that return errors, and expensive tool calls. It does not measure task outcome quality.
- The meta project's changes reach agents through the Agent SDK's `plugins` option (skills, agents, hooks, commands, MCP servers) and appended system prompt instructions.
- Changes from a meta agent are merged only after the user approves them.
- Split panes are no longer a product feature. The tab layout replaces the split-pane workspace in `docs/prds/mvp.md`.
- Out of scope: a notice board for agents to leave notes for each other. It was considered and dropped, because worktrees, meta proposals and the agent overview cover the same needs.
- Roadmap: agents that keep running after dia quits; scheduled meta agent runs; an approval step that copies parts of the meta repo into the user's `~/.claude` configuration; other users.

## Brand Commitments

- The name is `dia`, written in lower case.
- Polished consumer desktop app: the craft level of a well-made native app, not a bare-bones developer tool.
- Not a raw terminal-multiplexer look, and not a generic AI chat SaaS look.
- Attention signals are rare and reserved for agent state, so that a signal means the user is needed.

## Evidence on Hand

- dia's own repository and its use for dia's development are the only usage evidence.
- No other users, testimonials or metrics exist. Do not invent any.

## Product Principles

1. **Interrupt only when needed.** dia asks for the user's attention only when an agent is blocked on the user: a permission request, a question or a failure. Everything else is visible on request.
2. **Status without opening.** The user can tell what any agent is doing, and whether it needs them, from the agent overview, without opening its tab.
3. **Background by default.** An agent that is not on screen keeps working, and nothing in dia requires watching it.
4. **Improvements are reviewed.** A change that affects every agent, from the meta project or from a plugin, reaches the user as a change to approve, never as a silent edit.
5. **Fast under real use.** dia drives real development work, including its own, so latency is part of the design.

## Accessibility & Inclusion

WCAG AA contrast and full keyboard navigation. Status animations honour reduced-motion settings. OS notifications carry the agent's project, tab name and the reason, so that the notification text alone identifies the agent without the app open.
