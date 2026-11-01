# Agent SDK message display

Status: accepted. Issue #23 part 3 (part 1: #65, part 2: #70). Branches `feat/sdk-message-decisions` and `feat/background-tasks`.

## Name and Purpose

Records, for each of the 40 Agent SDK message kinds, whether the claude-code adapter shows it, logs it only, or hides it, and implements the rows #65 and #70 left undecided.

Scope: module. `plugins/claude-code/reducer.ts` (the mapping), and for `background_tasks_changed` the session protocol, the IPC contract, the pane chat state and the composer header (`plugins/chat`).

Source: the `SDKMessage` union in `@anthropic-ai/claude-agent-sdk` 0.3.311 `sdk.d.ts` (39 members; `result` splits into success and error).

## Rules

The decisions apply three rules, in this order:

1. **Transparency.** A message the user would act on, or that explains why the agent did or did not do something, is shown: a refusal, a failed hook, a failed sign-in, a recalled memory, background work that is still running.
2. **Sleek.** A routine success is not shown. Lifecycle starts, progress ticks and successes that change nothing the user can see are logged at debug level (`Agent SDK message not shown` in `plugins/claude-code/session.ts`), which every message that produces no protocol message already gets.
3. **Progressive disclosure.** A shown message uses the smallest element that carries it: the turn activity line for a state that ends, a tool row's detail for a tool's state, a one-line `notice` divider for a session event, and a closed popover for a list. Detail beyond one line is behind a click.

**Hide** means the message cannot reach dia's sessions (a feature dia does not enable or use); it is also logged by rule 2 if it arrives.

## Decisions

### Handled before this issue (10 rows)

| SDK message | Decision | Element | Reason |
| --- | --- | --- | --- |
| `system` / `init` | show: `SessionStarted` | none (binds the session id) | The command list comes from `supportedCommands()`; see `reducer.ts` |
| `assistant` | show: `AssistantMessageReceived`, text blocks | assistant message | Thinking and tool use arrive through `stream_event` deltas; the `error` field feeds parking (#70). Enough |
| `result` / `success` | show: `TurnCompleted` | turn end | Enough |
| `result` / error subtypes | show: `TurnErrored` naming the subtype | `error` row | Done in #65 |
| `user`, string or image content | show: `CheckpointAvailable` | rewind control | Enough. Replays arrive on the same branch because dia passes `replay-user-messages` |
| `user`, content blocks | show: `ToolCallCompleted` per `tool_result` | tool row | Enough |
| `stream_event` | show: `ToolCallStarted`, `AssistantTextDelta`, `AssistantThinkingDelta`, `ToolCallUpdated` (input) | streaming text, thinking, tool row | Enough |
| `system` / `commands_changed` | show: `SlashCommandsAvailable` | `/` menu | Enough |
| `system` / `compact_boundary` | show: `ConversationCompacted` | compaction divider | Enough |
| `conversation_reset` | show: `ConversationReset` | cleared transcript | Enough |

### Decided in #65 and #70 (11 rows)

| SDK message | Decision | Element |
| --- | --- | --- |
| `system` / `status` | show: `TurnStatusChanged` while compacting; failed compaction → `SessionNotice` + `CompactionFailed` | activity line, divider |
| `system` / `api_retry` | show: `TurnStatusChanged` (`Retrying (attempt 2 of 10) in 4s · 529`) | activity line |
| `system` / `model_refusal_fallback` | show: `SessionNotice` | divider |
| `system` / `local_command_output` | show: `AssistantMessageReceived` | assistant message |
| `system` / `task_notification` | show when failed: `ToolCallUpdated` detail | tool row |
| `system` / `task_progress` | show: `ToolCallUpdated` detail | tool row |
| `system` / `thinking_tokens` | show: `TurnStatusChanged` (`Thinking · ~1.2k tokens`) | activity line |
| `system` / `permission_denied` | show: `ToolCallUpdated` detail (`Denied: …`) | tool row |
| `system` / `informational` | show when not `info` and not tied to a tool: `SessionNotice` | divider |
| `tool_progress` | show for the main thread: `ToolCallUpdated` elapsed time | tool row |
| `rate_limit_event` | show on entering `allowed_warning`: `SessionNotice`; rejected → parks the turn (#70) | divider, parked state |

### Decided here (19 rows)

| SDK message | Decision | Element | Reason |
| --- | --- | --- | --- |
| `system` / `model_refusal_no_fallback` | show: the turn ends with `TurnErrored` (`claude-opus-5-5 declined the request: <explanation>`) instead of `TurnCompleted` | `error` row; the pane and sidebar show `Errored` | The turn produced nothing and needs a reworded prompt from the user; `Errored` is the existing state that asks for the user's input and keeps the session. Without an explanation the text is the message's `content`. Main-thread assistant text after the refusal (not on the refused frame, `stop_reason: refusal`) means the turn recovered, so it completes normally; this covers a refused subagent request the main agent works around |
| `system` / `hook_response` | show when `outcome` is `error`: `SessionNotice` (`SessionStart:startup hook failed (exit 1): <first stderr line>`); log otherwise | divider | A failing hook changes the session silently otherwise. Success and `cancelled` are routine |
| `system` / `hook_started` | log only | | Its outcome arrives in `hook_response` |
| `system` / `hook_progress` | log only | | Its outcome arrives in `hook_response` |
| `system` / `plugin_install` | show when `failed`: `SessionNotice` (`Plugin install failed: <name>: <first line of error>`); log otherwise | divider | A Claude Code plugin the user expects is missing. Emitted only with `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` |
| `system` / `notification` | show when `priority` is `high` or `immediate`: `SessionNotice` with the first line of its `text`; log otherwise | divider | Claude Code's REPL shows these; `low` and `medium` are transient hints |
| `system` / `memory_recall` | show: `SessionNotice` (`Recalled from memory: auth.md, testing.md and 1 more`) | divider | The SDK documents it for an inline "Recalled from memory" row; it explains context the user did not send. File names only, at most three, to keep one line; a synthesis entry (`<synthesis:DIR>`) is named `synthesized memories` |
| `auth_status` | show: `TurnStatusChanged` (`Signing in`) while `isAuthenticating`, cleared when it ends; `error` → `SessionNotice` (`Sign-in failed: <error>`) | activity line, divider | A turn waiting on sign-in otherwise looks stalled |
| `system` / `background_tasks_changed` | show: new `BackgroundTasksChanged` → a `N in background` control in the composer header that opens a list of the tasks' descriptions; absent when no task runs | composer header popover | Work the agent started (a background shell, a subagent) keeps running after the turn ends and can wake the agent; nothing else shows it. The message is a level signal, so the list is replaced on each message |
| `system` / `task_started` | log only | | The tool row of the call that started the task already shows it; background tasks appear through `background_tasks_changed` |
| `system` / `task_updated` | log only | | Failures arrive in `task_notification`; membership in `background_tasks_changed` |
| `system` / `session_state_changed` | log only | | `result` already ends turns; `requires_action` is the permission request dia already shows |
| `tool_use_summary` | log only | | The steps section already summarises a run of tool calls (count, failures, duration) |
| `system` / `control_request_progress` | hide | | Reports only `side_question` control requests, which dia never sends |
| `system` / `files_persisted` | hide | | Files API persistence for remote sessions; dia runs local sessions |
| `system` / `elicitation_complete` | hide | | dia registers no MCP elicitation handler |
| `system` / `worker_shutting_down` | hide | | Emitted by the remote bridge only |
| `system` / `mirror_error` | hide | | Emitted by a `SessionStore` mirror, which dia does not configure |
| `prompt_suggestion` | hide | | Emitted only when `promptSuggestions` is on; dia does not enable it |

## Interface changes

- `plugins/claude-code/reducer.ts`: the rows above. Every notice text from these rows is one line of at most 200 characters, cut with `…`. A refusal is remembered until the turn's `result`, like a park cause; a park cause wins over a refusal.
- `BackgroundTasksChanged { tasks: ReadonlyArray<{ taskId: string; description: string }> }` (`src/host/session/protocol.ts`), forwarded as the pane event `PaneBackgroundTasksChanged`; `PaneChatState.backgroundTasks` holds the latest list. `PROTOCOL_VERSION` is bumped.

## Not covered

- Notices are not rebuilt when a transcript is reloaded from history, the same as the notices #65 added.
- The rows marked show were checked against the SDK types and reducer tests. A refusal, a failing hook, a failed plugin install, a high-priority notification, a memory recall and a sign-in could not be produced on demand in a real session.
