---
status: "accepted"
date: 2026-10-24
decision-makers: William Pei
---

# Split plugins into one adapter category and one feature category, and move the Agent SDK into a Claude Code adapter

## Context and Problem Statement

ADR-0019 made every feature a plugin and kept the Agent SDK `query()` lifetime in the kernel. Phase 4 (issue #9) then moved slices of the SDK integration into separate plugins: `session-reducer` (about 220 LOC), `permissions` (about 135 LOC) and `thinking` (about 32 LOC). The kernel needs one seam file per plugin to load them (`src/host/session/*-seam.ts`, about 424 LOC), and ADR-0028 made three of them essential, which means they cannot be unloaded or overridden. The code that calls the SDK stayed in the kernel: `query()`, `canUseTool` and the message stream in `src/host/session/agent-session.ts`, transcripts in `src/host/services/transcript-reader.ts`, and the SDK MCP server in `src/host/session/plugin-tools.ts`. Neither ADR-0019, ADR-0028 nor issue #9 records a reason for splitting the SDK integration into separate plugins. How should plugins be grouped, and where does the Agent SDK integration live?

## Decision Drivers

* All translation between dia and the local Claude Code install belongs in one place.
* The code that translates between dia and the agent must not contain UI.
* A plugin reload must not interrupt an agent turn that is streaming (ADR-0019).
* One user-facing feature should be one plugin directory, not a group of plugins split by role.
* A plugin that can be neither unloaded nor overridden is kernel code in a different directory, and it costs a seam on top of its own code.

## Considered Options

* Adapter and feature categories (chosen).
* deepseek-harness roles: `adapter`, `service`, `tool` and `ui` as separate plugins.
* Process categories: `adapter`, `host` and `renderer`.
* Merge `session-reducer`, `permissions` and `thinking` into one plugin, and keep `query()` in the kernel.

## Decision Outcome

Chosen option: "Adapter and feature categories", because it puts the whole Agent SDK integration behind one interface and keeps each user-facing feature in one directory.

### Categories

| Category | Contains | Hot reload | Worktree override | Can be unloaded | Count |
| --- | --- | --- | --- | --- | --- |
| `adapter` | Translation between dia and one agent: dia operations become agent operations, and agent output becomes dia protocol messages. No UI. | No. A change needs an app restart. | No. Only the shipped copy loads. | No | One: `plugins/claude-code` |
| `feature` | One user-facing feature: an optional `host.ts`, an optional `renderer.ts`, and agent tools. | Yes (ADR-0020, ADR-0026) | Yes | Yes | Any |

* Features have no "required" flag. Unloading `chat` leaves an empty pane, and `plugin_clear_override` restores a broken override.
* `ESSENTIAL_PLUGINS` in `src/shared/plugin/manifest.ts` is removed. The adapter category covers what the kernel cannot run without, and the kernel holds dia core.
* `load: "eager" | "lazy"` (ADR-0027) applies to features. The adapter loads before `HostReady`.

### Placement

| Code today | Moves to |
| --- | --- |
| `query()` lifetime, input queue, `canUseTool`, stream wrapping, `resolveClaudeExecutable`, `supportedCommands()` (`src/host/session/agent-session.ts`) | `plugins/claude-code` |
| `plugins/session-reducer` (`SDKMessage` → `OutboundMessage`) | `plugins/claude-code` |
| `plugins/thinking` (`ThinkingLevel` → SDK `thinking` and `effort`) | `plugins/claude-code` |
| `permission-mode-controller` (`setPermissionMode`) from `plugins/permissions` | `plugins/claude-code` |
| `canUseTool` → `PermissionRequested`, `QuestionRequested`, `PlanReviewRequested` | `plugins/claude-code` |
| File checkpoint SDK calls: `enableFileCheckpointing`, rewind (ADR-0018) | `plugins/claude-code` |
| `getSessionMessages` (`src/host/services/transcript-reader.ts`) | `plugins/claude-code` |
| `createSdkMcpServer` for dia's plugin tools (`src/host/session/plugin-tools.ts`) | `plugins/claude-code` registers tool specs that the kernel defines |
| `pending-user-input` from `plugins/permissions` | kernel (`src/host`) |
| `src/host/session/*-seam.ts` | deleted; replaced by one agent backend interface in the kernel |
| `plugins/git-ops` | feature `plugins/worktrees` |
| Chat UI, permission card, question card, rewind button | feature `plugins/chat` |
| `updater.ts` | kernel (`src/main`); plugins run in the Host only |

### Agent backend interface

* The kernel imports no `@anthropic-ai/claude-agent-sdk` module. The adapter implements one kernel-defined interface that starts a session, sends a message, changes permission mode and thinking level, answers a pending request, rewinds, reads a transcript and registers dia tools.
* There is one adapter. dia's shared types stay Claude-shaped: `PermissionMode` uses the SDK mode names, `ConversationMessage` carries SDK message ids as `checkpointUuid` and `resumeAnchorUuid`, `SlashCommandInfo` mirrors `supportedCommands()`, and `PermissionUpdate` is an opaque SDK payload. Neutral types and adapter capability flags wait until a second adapter exists.
* The adapter answers `canUseTool`. Because only the shipped copy loads and it cannot be reloaded, no plugin operation exposed by the Host can replace the permission gate. This keeps the guarantee ADR-0028 gave.

### Consequences

* Good, because every Agent SDK import sits in one plugin, and the four seam files are replaced by one interface.
* Good, because a streaming turn never meets an adapter reload, since the adapter cannot be reloaded. The ADR-0019 driver holds without a reload rule for live sessions.
* Good, because a feature such as #15 (notifications) is one directory with its host logic, its UI and its tools.
* Bad, because the agent loop from issue #8 cannot refine SDK behaviour live. An edit to `plugins/claude-code`, including how an SDK message type is displayed (issue #23), needs an app restart, and an override in a worktree is ignored.
* Bad, because a second agent backend would need dia's shared types reworked.
* Bad, because ADR-0019's "every user-facing feature is replaceable" no longer holds for the adapter, `pending-user-input` or the updater.

## Pros and Cons of the Options

### Adapter and feature categories

* Good, because one feature is one directory, and `plugin.json` already accepts both `host` and `renderer` entries (`plugins/example`).
* Bad, because a feature that holds host logic and UI reloads both together.

### deepseek-harness roles

deepseek-harness has no plugin kinds; it groups about 372 packages by naming role: service definitions, `<seam>-<backend>` providers, `tool-*` consumers and `ui-*` plugins (`docs/architecture.md`, master `22ddee3`).

* Good, because each role can be replaced alone.
* Bad, because one feature is two to four plugins. Approvals there are `user-approval`, `ui-approval`, `tool-ask-user` and `permission-presets`.

### Process categories

* Good, because each plugin runs in one process.
* Bad, because a feature with logic and UI is two plugins.

### Merge the three SDK plugins and keep `query()` in the kernel

* Good, because the change is small and amends ADR-0028 only.
* Bad, because the kernel keeps calling the SDK, so the merged plugin is not an adapter.

## More Information

* Supersedes ADR-0028. Amends ADR-0019: the kernel no longer owns `query()`, and "every feature is a built-in plugin" now reads "every replaceable feature is a feature plugin".
* The current-state facts in this record (file names, LOC, seams, `ESSENTIAL_PLUGINS`) were read from the repo at commit `cd50e1f`. Implementation has not started.
* deepseek-harness facts were read from `deepseek-ai/deepseek-harness` master `22ddee3` through the GitHub API (`docs/architecture.md`, `packages/README.md`, `packages/llm/README.md`, `packages/client/README.md`, `packages/interaction/README.md`). The closest deepseek-harness match to dia's adapter is an `llm-*` provider registered through `ctx.llm.registerAdapter`, which is an ordinary plugin there.
* Follow-up: issue #9 (Phase 4 checklist), issue #16 (adding `query()` options becomes an adapter operation), issue #23 (the message mapping lives in the adapter).
