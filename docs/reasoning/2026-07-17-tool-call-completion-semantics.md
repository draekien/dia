# Tool-call completion fires on the tool_result, not content_block_stop

**Date:** 2026-07-17

## Context

Bullet 07 needed a "which tool is currently running" indicator per pane (US-18: a pane shouldn't "look idle mid-task"). `agent-session.ts` already emitted `ToolCallStarted`/`ToolCallCompleted`, so the work looked like pure plumbing (bridge + UI). The question was when `ToolCallCompleted` should fire.

## Reasoning / Learning

The original code emitted `ToolCallCompleted` on the SDK stream's `content_block_stop` event. That event marks the moment the tool's **input JSON finished streaming** — *not* when the tool finished executing. Per the Agent SDK message flow (`docs/llms/agent-sdk.txt` → streaming-output / agent-loop): all `tool_use` content blocks stop → the complete `AssistantMessage` is yielded → *then* the SDK executes the tools (no stream events emitted during execution) → each result comes back as a `type: 'user'` message whose `message.content` array carries `tool_result` blocks, each with a `tool_use_id` correlating to the originating `tool_use` block's `id`.

So a `content_block_stop`-based indicator flashes during the brief input-generation window and clears *before* the tool actually runs — the exact inversion of US-18, worst for long `Bash` calls. (The SDK's own "Build a streaming UI" doc example uses this window, so it's an accepted-but-shallow pattern.)

Fix: re-map completion to real execution. `ToolCallStarted` still fires at `content_block_start` (indicator appears as input streams); the accumulated input is stashed at `content_block_stop`; `ToolCallCompleted` is emitted only when the matching `tool_result` arrives, correlated by `tool_use_id`. A denied tool still produces a `tool_result` (the rejection message), so the indicator clears on every path; pending calls are also flushed on turn end (`result` message) so an aborted turn can't leave it stuck.

The event-folding logic was extracted into a pure `agent-session-reducer.ts` (`makeSessionEventReducer`) so this correlation is unit-testable — `agent-session.ts` self-executes `Effect.runFork` at import and `runSession` was unexported, so the mapping had no test seam otherwise.

## Implication

- `ToolCallCompleted` means "the tool finished executing," keyed off the `user`/`tool_result` message — not "input finished streaming." Don't revert it to `content_block_stop`; the reducer test `defers completion until the tool result arrives` guards this.
- The `tool_result` block also carries the tool's output (`content`, flattened to text — non-text blocks become `[type]`) and an `is_error` flag; both are captured onto `ToolCallCompleted` (`output`/`isError`) and threaded through to `PaneToolCallCompleted` for the renderer (the TanStack AI adapter emits them as the AG-UI `TOOL_CALL_RESULT`, per ADR-0014). Turn-end flushes have no result, so they complete with empty `output` and `isError: false`.
- Correlation is by `tool_use_id`, never by arrival order or block index — subagent tool results (with `parent_tool_use_id` set) whose ids were never registered via stream events are naturally ignored.
- New per-event SDK→protocol mapping belongs in `agent-session-reducer.ts` (pure, tested), not inline in the effectful shell.
