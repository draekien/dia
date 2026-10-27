# The Agent SDK's task tools are opt-in on newer models

**Date:** 2026-10-28

## Context

After the upgrade from `@anthropic-ai/claude-agent-sdk` 0.3.207 to 0.3.311, a packaged build was asked to "Use your todo-list tool to record exactly one todo item". The agent on `claude-sonnet-5-5` replied that no todo tool was available, and the pane's agent summary stayed `NoActivity`. The same prompt on a packaged build of `main` (SDK 0.3.207) ran `TaskCreate`, and the summary became `ToolUse` with `tool: "TaskCreate"`.

## Reasoning / Learning

- SDK 0.3.142 replaced `TodoWrite` with `TaskCreate`, `TaskGet`, `TaskUpdate` and `TaskList` in SDK sessions.
- SDK 0.3.233 removed these tools from the default tool set on Opus 4.8, Sonnet 5, Fable 5, Mythos 5 and newer models. 0.3.268 restated this as: they are default only on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6 and Haiku 4.5. The changelog gives three ways to keep them: name them in `tools`, reference them in `allowedTools`, or set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.
- Source: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md (sections 0.3.142, 0.3.233 and 0.3.268).
- `tools` was ruled out because it restricts the session to the listed tools. The environment variable was ruled out because `options.env` replaces the child process environment. `allowedTools` keeps the tools available and also auto-approves them, which is safe because they only change the session's own task list.

## Implication

`plugins/claude-code/session.ts` passes `TASK_TRACKING_TOOLS` as `allowedTools` on every `query()`, including the query a rewind forks; `session-rewind.test.ts` covers both. The agent summary in `src/shared/domain/agent-summary.ts` shows a todo line only for `TodoWrite`. On current SDK sessions the task tools appear as a `ToolUse` activity, not a `Todo`.
