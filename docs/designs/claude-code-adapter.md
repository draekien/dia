# Claude Code adapter and the agent backend interface

## Purpose

Phase 4, adapter step (issue #9, ADR-0029). Every use of `@anthropic-ai/claude-agent-sdk` moves into the shipped plugin `plugins/claude-code`, which provides one kernel-defined `AgentBackend`. The kernel keeps the pane lifecycle (`PaneSupervisor`), the hand-off of the pending-request registry, the dia tool definitions and the protocol (`OutboundMessage`), and imports no SDK module. The seams `session-reducer-seam.ts`, `thinking-seam.ts` and `permissions-seam.ts` are deleted, and the plugins `session-reducer` and `thinking` are deleted; their code moves into the adapter. `permission-mode-controller` moves from `plugins/permissions` into the adapter.

Status: the follow-up step is `docs/designs/adapter-category.md`. It deleted `ToolGate`, `resolvePendingUserInput`, `pending-user-input-resolver.ts`, `plugins/permissions` and `ESSENTIAL_PLUGINS`: `AgentSessionOptions` takes `tools`, and the adapter creates its own `PendingUserInput` with the kernel's `makePendingUserInput`. The sections below describe the adapter step as it was built.

Not in this step (the next #9 item): moving `pending-user-input` into the kernel, the `adapter`/`feature` category, and deleting `ESSENTIAL_PLUGINS`. Until then `plugins/permissions` still provides `PendingUserInput`. Until the category step, `ESSENTIAL_PLUGINS` stops the adapter being unloaded or overridden; it does not stop `plugin_reload claude-code`, which stays user-approved.

## Interface

```
src/host/session/agent-backend.ts                         (kernel)
  AGENT_BACKEND_KEY = 'agentBackend'                      value: AgentBackend
  interface AgentSession { sendText, setThinkingLevel, setPermissionMode, resolvePermission,
                           resolveQuestion, resolvePlanReview, interrupt, rewindToCheckpoint,
                           ended }                        (moved unchanged from agent-session.ts)
  interface AgentSessionOptions {
    config: PaneConfig
    resume: Option<SessionId>                             None: a new conversation
    emit: (message: OutboundMessage) => Effect<void>
    toolGate: ToolGate
  }
  type ToolGate = Data.TaggedEnum<{
    AskUser: { userInput: PendingUserInput; tools: ReadonlyArray<DiaTool> }
    DenyAll: {}                                           every tool call denied; no dia tools offered
  }>
  const ToolGate = Data.taggedEnum<ToolGate>()
  interface AgentBackend {
    openSession(options: AgentSessionOptions): Effect<AgentSession, never, Scope>
    readHistory(sessionId: SessionId, cwd: string): Effect<ReadonlyArray<ConversationMessage>>
  }
  resolveAgentBackend(registry: Pick<PluginRegistry, 'inject'>): Effect<AgentBackend>
    never fails; returns the kernel's unavailable backend when no valid one is provided

src/host/session/pending-user-input-resolver.ts           (kernel; replaces permissions-seam.ts;
                                                           deleted by the next step)
  PENDING_USER_INPUT_KEY, Superseded, UserInputResolution, PendingUserInput   (moved unchanged)
  resolvePendingUserInput(registry): Effect<Option<PendingUserInput>>          never fails

src/host/session/dia-tools.ts                             (kernel; replaces plugin-tools.ts)
  interface DiaToolField { description: string; pattern: RegExp }
  interface DiaToolResult { text: string; isError: boolean }
  interface DiaTool {
    name: string                                          e.g. 'plugin_reload'
    description: string
    input: Record<string, DiaToolField>                   every field is a required string
    run(input: Record<string, string>): Effect<DiaToolResult>
  }
  interface PluginToolHost { reload, setOverride, clearOverride }               (unchanged)
  makePluginTools(host: PluginToolHost): ReadonlyArray<DiaTool>

src/shared/domain/pane.ts
  SessionId = Schema.String.pipe(Schema.brand('SessionId'))
  used by: AgentSessionOptions.resume, AgentBackend.readHistory, SessionStarted.sessionId and
  ConversationReset.newSessionId (protocol.ts), the persisted pane record's sessionId
  (persistence.ts); pane-workspace and pane-supervisor pass it through

src/host/services/pane-supervisor.ts
  SessionFactoryLive: at every session start resolves the backend and the pending-user-input
  registry, builds ToolGate.AskUser with the plugin tools (or ToolGate.DenyAll when the registry
  is missing), then calls backend.openSession
src/host/services/transcript-reader.ts
  TranscriptReaderLive requires HostPlugins; readHistory delegates to the resolved backend

plugins/claude-code/                                      { name: 'claude-code', api: '1', host: 'host.ts', load: 'eager' }
  host.ts                          ctx.provide(AGENT_BACKEND_KEY, makeClaudeCodeBackend())
  backend.ts                       makeClaudeCodeBackend(): AgentBackend
  session.ts                       query() lifetime, input queue, canUseTool, restarts, rewind
                                   (from src/host/session/agent-session.ts)
  claude-executable.ts             resolveClaudeExecutable
  reducer.ts                       SDKMessage -> OutboundMessage  (from plugins/session-reducer)
  thinking-options.ts              ThinkingLevel -> SDK options   (from plugins/thinking)
  permission-mode-controller.ts    (from plugins/permissions); LivePermissionQuery and
                                   PermissionModeController become private to the adapter
  transcript.ts                    getSessionMessages + sessionMessagesToConversation
                                   (from src/host/services/transcript-reader.ts)
  tool-server.ts                   DiaTool -> createSdkMcpServer tool, with the approval step
                                   (from src/host/session/plugin-tools.ts)
  *.test.ts                        moved with their code

plugins/permissions/
  host.ts provides only pendingUserInput; permission-mode-controller.ts and its test move out

src/host/plugin-api.ts
  re-exports AGENT_BACKEND_KEY and the agent-backend types, the pending-user-input types and
  Superseded, the dia-tool types, and the attention schemas the adapter uses at runtime
  (Question, PlanReviewResponse); drops SESSION_REDUCER_KEY, THINKING_OPTIONS_KEY,
  PERMISSION_MODE_CONTROLLER_KEY and their types
src/shared/plugin/manifest.ts
  ESSENTIAL_PLUGINS = ['claude-code', 'permissions', 'git-ops']

Callers updated: host-main.ts, pane-supervisor.ts and its test, pane-workspace.test.ts.
Deleted: agent-session.ts, plugin-tools.ts, the three seams and their tests,
plugins/session-reducer, plugins/thinking.
```

## Behaviour

- Nothing outside `plugins/claude-code` imports `@anthropic-ai/claude-agent-sdk`, test files included.
- `resolveAgentBackend` returns the provided value when it has `openSession` and `readHistory` functions. Otherwise it logs an error and returns the kernel's unavailable backend: its `openSession` returns a session whose `ended` completes at once with `The claude-code adapter is not loaded` and whose other methods log a warning and do nothing (the supervisor marks the pane `Crashed` and tears it down as soon as `ended` completes); its `readHistory` returns an empty list. `SessionFactoryLive` and `TranscriptReaderLive` call the resolved backend without branching.
- While the adapter is not loaded, each `SendMessage` reopens the pane (`pane-workspace.ts` `ensureLive`), which crashes at once and is torn down, and the message is dropped with a warning. There is no restart loop, because only `SendMessage` and the boot-time `resumePane` start a pane. Once the adapter loads, the next `SendMessage` starts the session.
- `resolvePendingUserInput` returns `None` and logs an error when `plugins/permissions` does not provide a function under `pendingUserInput` or the function throws. It calls the provided factory once per call, so every session gets its own registry. `SessionFactoryLive` then passes `ToolGate.DenyAll`: the adapter registers no dia tools and its `canUseTool` denies every tool call. Today the dia tools are registered in that case and decline when called; after this change the agent is not offered them.
- The adapter's `canUseTool` lets a dia tool through (it asks the user itself) and gates every other tool exactly as `makeCanUseTool` does today. Each dia tool call asks the user through the session's `PendingUserInput` and `emit` (`PermissionRequested` with tool name `mcp__dia__<name>`) in every permission mode, and does not run `run` when the user declines.
- `makePluginTools` returns `plugin_override`, `plugin_reload` and `plugin_clear_override` with today's names, descriptions, field patterns and result texts; the adapter builds `z.string().regex(field.pattern).describe(field.description)` per field. `directory` uses the pattern `/[\s\S]/`, which accepts exactly what `min(1)` accepts.
- Thinking options, the session reducer and the permission-mode controller are used directly by the adapter with no fallback: a throw in the reducer fails the session stream, and the pane is marked `Crashed`, like any other session failure.
- A reload of `claude-code` applies from the next session start; a running session keeps the closures it was created with, because its resources live in the pane's scope, not the plugin's.
- The adapter builds a new MCP server from `options.tools` for every `query()`, restarts included, because the SDK binds a server instance to one query. It captures the Effect context once in `openSession` and runs `canUseTool` and each `DiaTool.run` with it. Dia-tool approval request ids stay `plugin-tool-<Clock ms>-<per-session counter>`.
- With `ToolGate.DenyAll` the adapter uses an inert registry for `resolve`, `interruptAll` and `drop`; `interrupt` still calls `query.interrupt()`. `setPermissionMode` now works without the permissions plugin, because the mode controller moved into the adapter; today it logs a warning and does nothing in that case.
- `PluginInfo` and `DiaRpcs` do not change, so `PROTOCOL_VERSION` stays 5. Removing `sessionReducer`, `thinkingOptions` and `permissionModeController` is a deliberate break (ADR-0029): a plugin that still provides one of them loads, and nothing reads the value. `PLUGIN_API_VERSION` stays `'1'` because every plugin is first-party (third-party plugins are on the roadmap) and the shipped plugins are updated in the same change. A saved override for the deleted `session-reducer` or `thinking` keeps listing that plugin from its override directory; it loads and provides a key nobody reads.
- `ESSENTIAL_PLUGINS` drops `thinking` because the plugin is deleted, and adds `claude-code`.
- `openSession` logs `Starting query session` with `paneId` as today; `resolveAgentBackend` logs at debug which plugin value it resolved.

## Constraints

- The adapter imports only `effect`, `zod`, `@anthropic-ai/claude-agent-sdk`, Node built-ins, `@dia/plugin`, and type-only `@shared/*`, because a shipped plugin cannot import `src/`. The resolve hook passes every specifier other than `effect` and `@dia/plugin` to Node's resolution from the plugin directory (`plugin-modules.ts`).
- `PendingUserInput` stays a kernel type; the adapter uses it only through `ToolGate.AskUser`.
- `SessionId` values are created by decoding or `SessionId.make` where an id enters dia: the adapter's reducer and the persisted record's decode.
- `resolveClaudeExecutable` resolves from the adapter module's own URL; `createRequire` ignores the generation query on that URL. In a packaged build the SDK's native package sits under `app.asar.unpacked` (`docs/reasoning/2026-07-19-packaging-asarunpack-claude-cli.md`); this is checked by the packaged run.
- The SDK sits outside the plugin root, so the loader records it as an external dependency; it does not change while the app runs.
- `electron.vite.config.ts` keeps `ssr.external` for the SDK as a guard, although no bundled module imports it after this change; `electron-builder.yml` keeps `asarUnpack` for it.
- `zod` and `@anthropic-ai/claude-agent-sdk` stay in `dependencies` (package.json), because a packaged plugin resolves them from `app.asar/node_modules`; the packaged run checks this.
- Moved code drops its inline narration comments; JSDoc on exports stays.
- Seam tests are ported, not dropped: `pending-user-input-resolver.test.ts` keeps a fresh registry per call, not-a-function, factory-throws and reload-while-pending; `agent-backend.test.ts` covers `resolveAgentBackend` with a missing, non-object and function-less value and with a valid backend; the adapter's `canUseTool` and approval tests move with `ToolGate.DenyAll` in place of `available: false`; a supervisor test runs `SessionFactoryLive` with no adapter loaded and asserts one `Crashed` and the pane removed; `transcript-reader.test.ts` tests that `TranscriptReaderLive.readHistory` calls the resolved backend and returns an empty list with the unavailable backend.
- Every export in `agent-backend.ts`, `dia-tools.ts`, `pending-user-input-resolver.ts` and the adapter has JSDoc stating its purpose and how to use it, with no implementation detail.

## Refinement record

| # | Finding | Rule | Tag | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `ESSENTIAL_PLUGINS` does not block a reload of the adapter. | Correctness | major | Applied: Purpose states it; reload is harmless to running sessions. |
| 2 | `/\S/` rejects input `min(1)` accepts. | Correctness | major | Applied: `/[\s\S]/`. |
| 3 | The fate of `PermissionModeController`, its key and `plugins/permissions/host.ts` was unstated. | Correctness | major | Applied. |
| 4 | `pending-user-input.ts` collides with the name the next step needs. | Naming | minor | Applied: `pending-user-input-resolver.ts`. |
| 5 | Dia-tool denial wording contradicted the `canUseTool` bullet. | Correctness | minor | Applied. |
| 6 | `PLUGIN_API_VERSION` claim needed evidence. | Correctness | minor | Applied: `plugins/example` checked. |
| 7 | Updated and deleted files were not listed. | Correctness | minor | Applied. |
| 8 | JSDoc rule for new exports unstated. | Project rule | major | Applied. |
| 9 | Success-path logging unstated. | Project rule | minor | Applied. |
| 10 | Two callers each handled a missing adapter. | Define errors out of existence | major | Applied: `resolveAgentBackend` returns an unavailable backend. |
| 11 | No-op methods on the unavailable session hide misuse. | Fail fast | minor | Rejected: the supervisor tears the pane down as soon as `ended` completes, and a racing RPC must not crash the Host; the warning log records it. |
| 12 | `PendingUserInput` ownership. | Information hiding | minor | Applied. |
| 13 | `startSession` name clashes with the private restart helper. | Names as documentation | minor | Applied: `openSession`. |
| 14 | Seam and permission tests would be dropped with their files. | Correctness | major | Applied: tests ported (Constraints). |
| 15 | Per-query tool server, captured context and request-id scheme unstated. | Correctness | major | Applied. |
| 16 | Recovery claim hid the dropped message while the adapter is missing. | Correctness | minor | Applied. |
| 17 | `userInput: None` behaviour for interrupt and mode changes unstated. | Correctness | minor | Applied. |
| 18 | One registry per session unstated. | Correctness | minor | Applied. |
| 19 | Removed keys are a public break; saved overrides of deleted plugins. | Correctness | minor | Applied as a stated break; `PLUGIN_API_VERSION` kept because all plugins are first-party. |
| 20 | Moved inline comments break the comment rule. | Project rule | minor | Applied. |
| 21 | `resolvePendingUserInput` still returns `Option`. | Define errors out of existence | minor | Accepted as temporary: the next step replaces it with a kernel-owned registry. |
| 22 | `ESSENTIAL_PLUGINS` diff unexplained. | Correctness | minor | Applied. |
| 23 | `None` comment contradicted the dia-tool bullets. | Correctness | minor | Applied. |
| 24 | `ssr.external` for the SDK becomes unused. | Correctness | minor | Applied as a stated guard: removing it is not needed for this step. |
| 25 | Why the packaged plugin can resolve `zod` and the SDK was unstated. | Correctness | minor | Applied. |
| 26 | No test for `TranscriptReaderLive` delegation. | Project rule | minor | Applied. |
| 27 | `resume: string \| undefined` is not typed as a session id. | User review | major | Applied: `Option<SessionId>`, with the brand at the session boundary. |
| 28 | `userInput: None` with non-empty `tools` is an impossible state. | User review; Define errors out of existence | major | Applied: `ToolGate` union; `DenyAll` offers no dia tools. |

Implementation note: a throwing reducer ends the session through the same failure path as any stream error (`runSession`'s `catchCause`); no separate adapter test was written for it, because it would need a fake SDK `query()`.
