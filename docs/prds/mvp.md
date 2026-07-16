# dia MVP — PRD

## Problem Statement

William is the sole user and developer of dia, a personal desktop alternative to Claude Desktop. Today, work with a Claude agent — including the work of building dia itself — happens one conversation at a time. Any time he wants to make progress on more than one thread at once (e.g. two areas of a codebase, or dia's own development alongside another project), he has to fully context-switch between separate sessions rather than have them running side by side. This slows down exactly the kind of parallel, exploratory work an agent-driven workflow should make easier, and it directly limits his ability to use dia to work on dia itself.

## Goals / Success Criteria

1. Dogfooding milestone reached: William uses dia itself, running multiple parallel panes, to carry out real development work on dia's own codebase — replacing his prior single-session workflow for this purpose.
2. dia supports at least 6 concurrent independent panes running without perceptible input lag.
3. 100% of pane layouts and per-pane conversation histories are correctly restored after an app restart, with zero data loss across a restart.
4. Every pane's attention state (awaiting permission / errored / completed) is visually reflected via its pulse indicator with no missed or incorrect state observed during testing.
5. Across repeated pane create/close cycles during testing, closing a pane that owns a worktree leaves zero orphaned worktrees behind.
6. Every clarifying question Claude asks (via `AskUserQuestion`), including free-text answers, is answerable from the pane UI with zero malformed or dropped answers observed during testing.
7. All four permission-response types (allow as-is, allow with modified input, deny with a message, allow-and-remember) are each exercised at least once during manual testing and correctly change the tool's execution or Claude's next action, with zero incorrect behavior observed.
8. A permission or clarifying-question prompt left unanswered when dia is closed is still present and answerable after dia is reopened, verified across at least 3 manual restart-while-pending test runs with zero lost requests.
9. Assistant responses appear in a pane incrementally as they're generated, and the tool currently running (if any) is visible, with no dropped, out-of-order, or batched-until-the-end chunks observed during testing.
10. Every supported permission mode (default, plan, accept-edits, bypass, don't-ask) is selectable at pane creation and changeable mid-session, and each produces the tool-approval behavior documented for that mode, with zero incorrect approvals or denials observed during testing.

## User Stories

1. As a user, I want to split my workspace into multiple panes so that I can run separate agent sessions in parallel, similar to tmux.
2. As a user, I want to split any pane further, in either direction, as many times as I need, so that my layout can adapt to however many parallel sessions I'm running at a given time.
3. As a user, I want each pane to run its own fully independent agent session so that one pane's conversation, working directory, and progress are unaffected by any other pane.
4. As a user, I want to choose a pane's working directory via a directory picker and set its model when I create the pane so that I can work on different projects or different parts of a project at once.
5. As a user, I want the option to create an isolated git worktree for a pane when its working directory is a git repo so that the pane's changes stay isolated from my main working copy and from other panes working in the same repo.
6. As a user, I want a pane's worktree to be automatically cleaned up when I close that pane so that I don't have to remember to remove it myself or accumulate stale worktrees over time.
7. As a user, I want a pane to pulse amber when its agent is waiting on a permission decision so that I notice it without having to actively watch every pane.
8. As a user, I want a pane to pulse red on an error and green on completion so that I can tell each pane's status at a glance across the whole layout.
9. As a user, I want to click a pulsing pane to focus it and have it expand so that I can easily see its context and act on its permission dialog.
10. As a user, I want my pane layout and every pane's conversation history to persist across app restarts so that I can resume all my parallel work exactly where I left off.
11. As a user, I want to answer Claude's multiple-choice clarifying questions, including typing my own answer when none of the options fit, directly from the pane so that I can guide a task with multiple valid approaches without it being treated as a tool permission prompt.
12. As a user, I want to edit a tool's proposed parameters before approving it so that I can allow an action scoped exactly the way I want instead of denying it outright.
13. As a user, I want to mark "always allow" for a specific kind of tool call from the permission dialog so that I stop being re-prompted for that same category of action in that pane going forward.
14. As a user, I want to deny a tool request with an explanation of what I'd prefer instead so that Claude adjusts its next attempt rather than repeating the same blocked action.
15. As a user, I want to send Claude a brand new instruction while a permission or question prompt is pending so that I can redirect it entirely instead of only being able to respond to the current request.
16. As a user, I want a permission or clarifying-question prompt that's still pending when I close dia to still be there when I reopen it, so an interrupted response doesn't lose Claude's request.
17. As a user, I want to see an agent's response appear incrementally as it's generated so that I can start reading before it finishes, rather than waiting on a blank pane.
18. As a user, I want to see which tool a pane's agent is currently running so that I understand what's happening while I wait, instead of a pane looking idle mid-task.
19. As a user, I want to choose a pane's permission mode (e.g. always ask, auto-accept edits, plan-only, bypass entirely) when I create it so that I can set how much autonomy that pane's agent starts with.
20. As a user, I want to change a pane's permission mode while it's running so that I can loosen or tighten its autonomy as I build trust in what it's doing, without closing and recreating the pane.

## Testing Decisions

**Approach:** Automated tests cover core logic that's straightforward to verify in isolation — pane layout tree operations (split, resize, close), session state persistence and restore, attention-state transitions, worktree creation/cleanup logic, the mapping between a clarifying question's answers/free text and the response format Claude expects, and accumulation of streamed text/tool-input chunks into the same complete values a non-streamed response would produce. Manual exploratory testing covers the interactive UX — pane splitting and resizing by hand, the focus/expand interaction, choosing a working directory and toggling worktree creation at pane-creation time, the end-to-end permission dialog flow including each response type (allow, allow with modified input, deny with message, allow-and-remember), the clarifying-question flow including free text, redirecting a pending prompt with a new instruction, restarting dia with a prompt left pending, confirming streamed text and tool-activity visibility feel immediate rather than batched, and exercising each permission mode both at pane creation and via a mid-session mode change — all run against real local Claude Code sessions.

**Constraints:** No production/customer data is involved, as this is a single-user personal app. Manual testing is performed on the developer's own machine against his own local Claude Code installation and real project directories, including dia's own repository.

## Out of Scope

- Cross-device sync or cloud backup of sessions or pane layout
- Multiple OS-level windows (a single app window containing all panes)
- User-configurable theming or appearance settings beyond the OS default light/dark look
- Per-pane MCP server selection or configuration UI (panes use whatever MCP servers are already configured in the user's existing Claude Code setup)
- Viewing, editing, or removing a previously remembered "always allow" rule, or hand-editing declarative allow/deny/ask rules, from within dia's UI (the underlying rule file is managed directly, outside the app) — permission mode selection (US-19, US-20) is the only in-app lever over automatic approval
- The `auto` (model-classified) permission mode, since its availability is plan-gated and unconfirmed for dia's local/personal use
- Rendering visual mockups (previews) alongside a clarifying question's options — options are shown as label and description only
- Structured input beyond `AskUserQuestion` (custom domain-specific approval UIs, external ticketing/workflow integrations)
- Clarifying questions from subagents (not available for subagent use per the underlying SDK)
- Changing a pane's working directory after the pane has been created (a new pane must be created to work in a different directory)
- Worktree creation for working directories that aren't git repositories
- Creating a worktree for a pane after it's already been created (the worktree toggle is only offered at pane-creation time)
- Confirmation prompts or safeguards before removing a worktree with uncommitted changes (closing a pane always removes its worktree immediately)
- Merging, rebasing, or otherwise reconciling a pane's worktree branch back into another branch (the user handles this with their own git tooling before closing the pane)

## Additional Notes

This MVP builds on dia's existing architecture decisions (see `docs/adr/`), including two made specifically to support this scope: running each pane as its own isolated Electron `utilityProcess` (ADR-0007), and persisting pane layout and session state as local JSON files rather than a database (ADR-0008).

This revision supersedes the original PRD's blanket exclusion of auto-approval in two steps: first, an explicit "always allow" action taken from the permission dialog itself (US-13) was brought into scope; second, user-selected permission modes — including accept-edits and bypass, which the first step still excluded — are now in scope via explicit mode selection at pane creation and mid-session (US-19, US-20), since that selection is a deliberate user choice rather than an ambient bypass.

## Open Questions

- What a pane should visually show while a permission or clarifying-question prompt is pending across an app restart (G-8, US-16) — e.g. whether it reads as "paused" versus its normal "awaiting permission" pulse — can be decided during implementation.
