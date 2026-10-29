# Architecture Decision Records

This directory holds dia's Architecture Decision Records (ADRs), written in [MADR](https://adr.github.io/madr/) format.

- `template.md` — the MADR template used for new records.
- `NNNN-title.md` — one record per decision, numbered sequentially.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-electron-as-desktop-app-shell.md) | Use Electron as the desktop application shell | accepted |
| [0002](0002-react-typescript-for-renderer.md) | Use React with TypeScript for the renderer | accepted |
| [0003](0003-agent-sdk-runs-in-electron-utility-process.md) | Run the Claude Agent SDK in an Electron utilityProcess | superseded by ADR-0021 |
| [0004](0004-electron-vite-for-build-tooling.md) | Use electron-vite for build tooling | accepted |
| [0005](0005-tailwind-and-shadcn-ui-for-styling.md) | Use Tailwind CSS and shadcn/ui for renderer styling | accepted |
| [0006](0006-pnpm-single-package-repo-layout.md) | Use pnpm with a single-package repo layout | accepted |
| [0007](0007-one-utility-process-per-pane.md) | Run one utilityProcess per pane for concurrent independent agent sessions | superseded by ADR-0021 |
| [0008](0008-local-file-persistence-for-session-and-layout-state.md) | Use local file-based persistence for pane layout and session state | superseded by ADR-0011 |
| [0009](0009-effect-ts-for-main-process-orchestration.md) | Use Effect TS for main-process orchestration logic | superseded by ADR-0010 |
| [0010](0010-extend-effect-ts-to-pane-process-orchestration.md) | Extend Effect TS to pane-process orchestration | accepted, amended by ADR-0015 |
| [0011](0011-delegate-transcript-persistence-to-agent-sdk-session-store.md) | Delegate conversation-transcript persistence to the Agent SDK session store | accepted |
| [0012](0012-effect-tsgo-for-effect-aware-typechecking.md) | Use @effect/tsgo for Effect-aware type checking | accepted |
| [0013](0013-shared-schema-module-for-cross-process-code.md) | Extract cross-process schemas into a platform-neutral `src/shared` module | accepted |
| [0014](0014-tanstack-ai-usechat-for-renderer-chat-state.md) | Use TanStack AI `useChat` with a custom IPC ConnectionAdapter for renderer chat state | superseded by ADR-0015 |
| [0015](0015-effect-atom-and-direct-ipc-reducer-for-renderer-chat-state.md) | Use effect-atom and a direct IPC-event reducer for renderer chat state | accepted, amended by ADR-0030 |
| [0016](0016-electron-builder-distribution-and-auto-update.md) | Distribute dia as an electron-builder NSIS installer with GitHub-backed auto-update | accepted |
| [0017](0017-frameless-window-with-native-overlay-controls.md) | Replace the native window frame with a custom titlebar and native overlay controls | accepted, header strip and colour sync superseded by ADR-0038 |
| [0018](0018-transcript-anchored-file-checkpointing-with-conversation-fork.md) | Transcript-anchored file checkpointing that forks the conversation on rewind | accepted |
| [0019](0019-thin-plugin-kernel-on-effect.md) | Build dia as a thin plugin kernel on Effect, with every feature as a plugin | accepted, amended by ADR-0029 |
| [0020](0020-plugin-source-loading-and-hot-reload.md) | Load first-party plugins from source in the dia repo, with per-plugin worktree overrides and hot reload | accepted |
| [0021](0021-single-host-process-for-all-panes.md) | Run every pane's agent session and all non-UI plugins in one Host process | accepted |
| [0022](0022-renderer-to-host-over-local-websocket.md) | Connect the renderer to the Host over an authenticated localhost WebSocket | accepted |
| [0023](0023-agents-as-tabs-within-registered-projects.md) | Organise agents as tabs within registered projects, replacing the split-pane layout | accepted |
| [0024](0024-background-agents-run-in-tabs-not-on-screen.md) | Run background agents in tabs that are not on screen; closing the window still quits dia | accepted |
| [0025](0025-meta-project-as-a-dia-owned-git-repo.md) | Run a meta project: a dia-owned git repo loaded into every agent, changed through approved proposals | accepted, amended by ADR-0036 |
| [0026](0026-plugin-reload-as-a-transaction-with-rollback-and-a-memory-limit.md) | Reload a plugin as a transaction with rollback, per-module generations and a memory limit | accepted |
| [0027](0027-eager-and-lazy-plugin-startup.md) | Load plugins as eager or lazy at startup, and report each plugin's progress to the renderer | accepted |
| [0028](0028-essential-plugins-and-the-permissions-plugin.md) | Keep essential plugins loaded and un-overridable, and move permission handling into one | superseded by ADR-0029 |
| [0029](0029-plugin-categories-adapter-and-feature.md) | Split plugins into one adapter category and one feature category, and move the Agent SDK into a Claude Code adapter | accepted |
| [0030](0030-user-turns-appear-when-the-host-reports-them-sent.md) | Show a user turn in the transcript when the Host reports it sent, not when the composer submits it | accepted |
| [0031](0031-renderer-plugins-fill-slots.md) | Renderer plugins draw the UI by filling slots: one root slot, and child slots declared by the plugin that fills it | accepted, amended by ADR-0038 |
| [0032](0032-background-activities-and-semver-plugin-api.md) | Plugins schedule background activities through the kernel, keep files in a data directory, and declare a semver plugin API version | accepted |
| [0033](0033-one-org-of-hired-role-agents.md) | Run one org of hired agents with roles, per-role and overall concurrency caps, and ad-hoc tabs outside the caps | accepted |
| [0034](0034-decision-path-and-decision-queue.md) | Review objective plans as a live decision path, and route everything that waits on the user through one decision queue | accepted |
| [0035](0035-task-memory-and-retros.md) | Give each task a scratchpad and a transcript record, require a retro before a task completes, and let the retro write scoped long-term memory | accepted |
| [0036](0036-tiered-self-improvement.md) | Let agents change the harness through `propose_change`, applied by a risk tier the user sets per change type | accepted |
| [0037](0037-run-the-users-claude-code-install.md) | Run the user's own Claude Code install, found by an override or on `PATH`, instead of the binary bundled with the Agent SDK | accepted |
| [0038](0038-transparent-overlay-and-inset-sidebar-frame.md) | Draw the window controls over a transparent overlay and use the shadcn inset sidebar as the window frame | accepted; frame superseded by ADR-0039 |
| [0039](0039-flush-window-frame.md) | Drop the inset card and make the window frame flush with 32px top rows | accepted |

## Adding a new ADR

Copy `template.md` to `NNNN-short-title.md` (next sequential number), fill it in, and add a row to the index above.
