# dia MVP — PRD

## Problem Statement

William is the sole user and developer of dia, a personal desktop alternative to Claude Desktop. Today, work with a Claude agent — including the work of building dia itself — happens one conversation at a time. Any time he wants to make progress on more than one thread at once (e.g. two areas of a codebase, or dia's own development alongside another project), he has to fully context-switch between separate sessions rather than have them running side by side. This slows down exactly the kind of parallel, exploratory work an agent-driven workflow should make easier, and it directly limits his ability to use dia to work on dia itself.

## Goals / Success Criteria

1. Dogfooding milestone reached: William uses dia itself, running multiple parallel panes, to carry out real development work on dia's own codebase — replacing his prior single-session workflow for this purpose.
2. dia supports at least 6 concurrent independent panes running without perceptible input lag.
3. 100% of pane layouts and per-pane conversation histories are correctly restored after an app restart, with zero data loss across a restart.
4. Every pane's attention state (awaiting permission / errored / completed) is visually reflected via its pulse indicator with no missed or incorrect state observed during testing.

## User Stories

1. As a user, I want to split my workspace into multiple panes so that I can run separate agent sessions in parallel, similar to tmux.
2. As a user, I want to split any pane further, in either direction, as many times as I need, so that my layout can adapt to however many parallel sessions I'm running at a given time.
3. As a user, I want each pane to run its own fully independent agent session so that one pane's conversation, working directory, and progress are unaffected by any other pane.
4. As a user, I want to set a different working directory and model for each pane so that I can work on different projects or different parts of a project at once.
5. As a user, I want a pane to pulse amber when its agent is waiting on a permission decision so that I notice it without having to actively watch every pane.
6. As a user, I want a pane to pulse red on an error and green on completion so that I can tell each pane's status at a glance across the whole layout.
7. As a user, I want to click a pulsing pane to focus it and have it expand so that I can easily see its context and act on its permission dialog.
8. As a user, I want my pane layout and every pane's conversation history to persist across app restarts so that I can resume all my parallel work exactly where I left off.

## Testing Decisions

**Approach:** Automated tests cover core logic that's straightforward to verify in isolation — pane layout tree operations (split, resize, close), session state persistence and restore, and attention-state transitions. Manual exploratory testing covers the interactive UX — pane splitting and resizing by hand, the focus/expand interaction, and the end-to-end permission dialog flow — run against real local Claude Code sessions.

**Constraints:** No production/customer data is involved, as this is a single-user personal app. Manual testing is performed on the developer's own machine against his own local Claude Code installation and real project directories, including dia's own repository.

## Out of Scope

- Cross-device sync or cloud backup of sessions or pane layout
- Multiple OS-level windows (a single app window containing all panes)
- User-configurable theming or appearance settings beyond the OS default light/dark look
- Per-pane MCP server selection or configuration UI (panes use whatever MCP servers are already configured in the user's existing Claude Code setup)
- Auto-approval or bypassing of tool-use permission prompts (every pane always shows its own permission dialog when the agent requests one)

## Additional Notes

This MVP builds on dia's existing architecture decisions (see `docs/adr/`), including two made specifically to support this scope: running each pane as its own isolated Electron `utilityProcess` (ADR-0007), and persisting pane layout and session state as local JSON files rather than a database (ADR-0008).
