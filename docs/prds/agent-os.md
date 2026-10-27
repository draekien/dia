# dia agent OS — PRD

## Problem Statement

William is dia's developer and its first user. dia's MVP (`docs/prds/mvp.md`) is a split-pane workspace built for watching up to 6 agents at once. He watches agents while they work less and less often: he starts agents in several projects and wants to return to one only when it needs his input or has failed. Today closing dia's window quits the app and ends every agent's turn (`src/main/index.ts`), dia raises no OS notifications, and the only way to learn an agent's state is to look at its pane. dia also has no list of projects, and the waste his agents repeat across projects (tool calls that fail the same way, commands that time out, files read twice) is fixed one project at a time by hand, if at all.

## Goals / Success Criteria

1. Every permission request, question and failure from an agent whose tab is not visible, or whose window is minimised or not focused, raises one OS notification, with zero missed and zero duplicate notifications observed during testing.
2. A finished turn in a tab that is not visible raises no OS notification and badges its tab.
3. Clicking an OS notification focuses dia's window on the agent's tab, in 100% of attempts during testing.
4. Switching tabs leaves every running agent running; across 20 tab switches away from and back to an agent during a streaming turn, zero turns are interrupted, dropped or duplicated.
5. The agent overview shows, for every agent in every registered project, its status and an activity line that matches the agent's latest `TodoWrite` `in_progress` item, or its last tool call when it has none, with no stale line observed during testing.
6. A proposal filed with `meta_propose` by an agent in one project, once combined by a meta agent and approved, is present in the next agent started in a different project.
7. A rejected meta branch changes no agent's configuration.
8. A push of the meta repo that contains a test secret is refused, in 100% of attempts during testing.
9. All `docs/prds/mvp.md` success criteria still hold, reading "pane" as "tab" and "pane layout" as the list of projects and their tabs. MVP user stories 1, 2 and 9 (splitting panes, and expanding a focused pane) no longer apply (ADR-0023).

## User Stories

1. As a user, I want to register a directory as a project so that I can start agents in it and the meta project can work across it.
2. As a user, I want to register a directory that is not a git repo so that non-code work can be a project too.
3. As a user, I want each agent in its own tab within a project so that I can run several agents per project.
4. As a user, I want agents in tabs I am not looking at to keep running so that I never have to watch an agent for it to make progress.
5. As a user, I want agents to keep running while dia's window is minimised or another app is focused so that I can work elsewhere while they progress.
7. As a user, I want an OS notification when a background agent requests a permission or asks a question so that I know when I am blocking it.
8. As a user, I want an OS notification when a background agent fails so that I can restart or redirect it.
9. As a user, I want a finished agent to badge its tab without a notification so that notifications stay limited to agents that need me.
10. As a user, I want to click a notification and land on that agent's tab so that I can answer it immediately.
11. As a user, I want an overview of every agent in every project with its status and current activity, which is also how I switch between agents, so that I know what each agent is doing without opening it.
12. As a user, I want agents that need input or have failed sorted to the top of their project in the overview so that I see them first.
13. As a user, I want to collapse project groups and filter the overview by agent or project name so that 10+ projects and 20+ agents stay usable.
14. As a user, I want a finished agent to stay in the overview until I archive it so that nothing disappears without my action.
15. As a user, I want archiving an agent to remove its worktree and keep its session transcripts, and deleting it to remove both, so that I can clean up without losing history I may want back.
16. As a user, I want to collapse the overview to a rail of status indicators so that the conversation gets the full width while status stays visible.
17. As a user, I want agents to report waste they encounter with `meta_propose` so that improvements come from real runs.
18. As a user, I want to start an agent in the meta project that reads every project and its transcripts and proposes changes so that waste found in one project is fixed for all of them.
19. As a user, I want every meta change to arrive as a branch I approve so that nothing changes every agent without my review.
20. As a user, I want a meta agent's change to a git-repo project to arrive on a branch in a worktree of that project so that it does not touch the working copy another tab is using.
21. As a user, I want to push the meta repo to a remote I choose so that I can keep it backed up or share it between machines.
22. As a user, I want dia to refuse a push of the meta repo that contains a secret so that a credential from a transcript never leaves my machine.

## Testing Decisions

**Approach:** Automated tests cover logic that can be checked in isolation: the project registry (registering a directory, detecting whether it is a git repo, persisting and restoring projects and tabs), the notification rule (which status changes in which visibility state raise a notification, a badge or nothing), the activity line derivation from `TodoWrite` and tool-use events, overview ordering, proposal storage and retrieval, construction of the `query()` options that load the meta repo, and the push refusal when the scanner reports a secret. Manual testing on the installed build covers OS notifications and clicking them, background tabs streaming during tab switches, the overview during real runs, and a full meta loop: a proposal filed in one project, a meta agent's branch, approval, and the change present in a new agent in another project.

**Constraints:** No production or customer data is involved. Testing runs on the developer's machine against his local Claude Code installation. Transcripts used in testing can contain local paths and command output; the meta repo used in testing has no remote except a throwaway one for the push-refusal test.

## Out of Scope

- Split panes; one tab is visible at a time (ADR-0023)
- A notice board for agents to leave notes for each other; considered and dropped, because worktrees, `meta_propose` and the agent overview cover its uses
- Keeping dia and its agents running in the system tray when the window closes; closing the window quits dia, as today (roadmap, ADR-0024)
- Agents that keep running after dia quits (roadmap)
- Scheduled or automatic meta agent runs; the user starts meta agents (roadmap: scheduled runs)
- Copying parts of the meta repo into `~/.claude` (roadmap)
- Measuring task outcome quality; the meta project looks only at waste in the agent environment
- Users other than William (roadmap); defaults must still not assume his machine or configuration
- An inbox view of agents waiting for input (roadmap; the overview's ordering covers it for now)
- Lifecycle rules that archive an agent automatically, for example when its pull request is merged or after a number of days without activity (roadmap)

## Additional Notes

This PRD builds on the plugin platform (`docs/prds/plugin-platform.md`, ADR-0019 to ADR-0022): its features are built as built-in plugins once Phase 2 of `docs/plans/2026-10-22-plugin-platform.md` provides the loader, and agents run in the Host from Phase 1. Its plan is `docs/plans/2026-10-23-agent-os.md`. Its decisions are ADR-0023 (tabs within registered projects), ADR-0024 (background agents) and ADR-0025 (meta project). The product definition is `PRODUCT.md`; the visual rules for the overview, tabs and status indicator are in `DESIGN.md`.

`docs/prds/org.md` extends this PRD (2026-10-28). It replaces `meta_propose` with `propose_change`, called by the retro after every task (ADR-0035); goals 6 and 7 and user story 17 are read with that change. It also adds outcome measurement through KPIs, so "Measuring task outcome quality" in Out of Scope applies to this PRD only.

Roadmap, not in this PRD:

* Keeping dia and its agents running in the system tray when the window closes.
* Agents that keep running after dia quits, which needs a Host that runs without Electron and the durable event store that ADR-0022 deferred.
* Scheduled meta agent runs while dia is running.
* An approval step that copies chosen parts of the meta repo into the user's `~/.claude`.
* An inbox view.
* Lifecycle rules that archive agents automatically.
* Other Claude Code users.

## Open Questions

- Which secret scanner checks meta repo pushes is decided during implementation.
