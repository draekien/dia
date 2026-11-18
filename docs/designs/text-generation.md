# Text generation and thread titles

`dia-text-generation` titles a user thread from its conversation with a one-shot call to an agent adapter's text generation capability, and lets the user regenerate a title and choose the adapter, model and effort that write it.

Scope: module (one new plugin) plus three seams in existing modules: a `textGeneration` capability on the `dia-agent-adapters` registration, `ctx.renameTab` on `HostPluginContext`, and a `ThreadRowMenuSlot` list slot in `dia-threads`. Stacked on `docs/designs/agent-adapter-registry.md` (ADR-0086).

## Success criteria

| # | Criterion | Proved by |
| --- | --- | --- |
| 1 | A thread with a generated name (`brave-otter`) is renamed to a generated title (an `AgentName`, ≤ 64 characters) after its first user message | test + app |
| 2 | A thread with a user-typed name, and an org-owned tab, keep their names after the first message | test |
| 3 | The title call uses the saved model, and the saved effort when the model's `effortLevels` lists it (otherwise thinking is disabled and no effort is sent); with nothing saved it uses `dia-claude-code` / `haiku` / `low`, and the app run records which options reached `query` | test + app |
| 4 | A changed model survives an app restart and is used for the next title | test + app |
| 5 | Right-click a thread → "Regenerate title" renames it from the conversation so far, including a thread the user renamed | test + app |
| 6 | A failed call (no install, timeout, empty answer) leaves the name unchanged and logs a warning | test |
| 7 | Claude Code's text generation runs with no tools, writes no transcript and starts no MCP server | test (options passed to `query`) |
| 8 | When the saved adapter is not registered, the title comes from the first registered adapter with text generation, using that adapter's default model, and a warning names that adapter | test |

## Interface

### `dia-agent-adapters` — `registry.ts` (capability)

```ts
/** One text generation call: the model follows `instructions` and answers `input` with text only. */
export interface TextGenerationRequest {
  readonly instructions: string
  readonly input: string
  readonly model: string
  readonly effort: EffortLevel
}

/** The call failed or answered with no text; `reason` is a sentence for the log. */
export class TextGenerationFailed extends Data.TaggedError('TextGenerationFailed')<{ readonly reason: string }> {}

/** An adapter's one-shot text generation: no tools, no stored session. Interrupting `generate` stops the call. */
export interface TextGeneration {
  /** The model a caller uses when it has no model of this adapter saved. */
  readonly defaultModel: string
  readonly generate: (request: TextGenerationRequest) => Effect.Effect<string, TextGenerationFailed>
}

export interface AgentAdapter {
  readonly id: string
  readonly label: string
  readonly backend: AgentBackend
  /** The adapter's text generation, or none when it registered without one. */
  readonly textGeneration: Option.Option<TextGeneration>
}

/**
 * … (existing text) … A `textGeneration` is offered to `adapters` readers with the registration
 * and is replaced and removed with it. A `textGeneration` without a non-empty `defaultModel` and a
 * `generate` function registers the adapter without text generation and logs an error naming
 * `ctx.name`.
 */
register: (
  ctx: { readonly name: string },
  adapter: { readonly label: string; readonly backend: AgentBackend; readonly textGeneration?: TextGeneration }
) => Effect.Effect<void, never, Scope.Scope>
```

`TextGenerationRequest.effort` is `EffortLevel` from `src/shared/domain/pane.ts`, exported to plugins from `src/host/plugin-api.ts`.

`calls.ts`: `AdapterSummary` gains `textGeneration: Schema.Boolean` ("whether the adapter offers text generation"). Two further edits carry it to the renderer: `adapter-registry.ts` `summaries` maps `textGeneration: Option.isSome(adapter.textGeneration)`, and `AdapterSummaryJson` in `src/shared/ipc/contract.ts` gains `readonly textGeneration: boolean`; `use-adapters.ts` needs no change. A test checks that a registration with and without `textGeneration` is summarised as `true` and `false`.

An invalid `textGeneration` leaves the adapter registered, unlike an invalid `backend`, because the adapter's sessions do not depend on text generation.

### `dia-claude-code`

`makeClaudeCodeTextGeneration({ install, dataDir, catalog })` returns a `TextGeneration` with `defaultModel: 'haiku'`; `host.ts` passes `ctx.dataDir` and gives the result to `register` as `textGeneration`.

`generate` resolves the install with `install.resolve`, then runs one `query` inside `Effect.acquireUseRelease` whose release calls `query.close()`, so a timeout or interruption by the caller stops the subprocess (the same reason `withIdleQuery` in `idle-query.ts` closes its query). Options:

```ts
{
  systemPrompt: request.instructions,
  model: request.model,
  ...effortOptions,
  tools: [],
  persistSession: false,
  strictMcpConfig: true,
  settingSources: [],
  maxTurns: 1,
  cwd: dataDir,
  ...installQueryOptions(path)
}
```

with `prompt: request.input`. It reads messages until the `result` message and returns its trimmed text. No install (`install.resolve` is `None`), an error result, or empty text fails with `TextGenerationFailed({ reason })`. `generate` reads the current model list as the first element of `catalog.models()` (`Stream.runHead`). `effortOptions` is `thinkingOptions(request.effort)` when that state is `Ready` and the model's `ModelOption.effortLevels` includes `request.effort`; otherwise (`Loading`, `Unavailable`, a model missing from the list, or an effort it does not list) it is `{ thinking: { type: 'disabled' } }` with no `effort`. Criterion 3's app run checks a `haiku` / `low` call. Criterion 7 is proved on the options passed to `query`; whether account-level (claude.ai) MCP connectors are also suppressed by `strictMcpConfig` is unverified.

### Kernel — `HostPluginContext.renameTab`

Declared on the shared `HostPluginContext` in `src/shared/plugin/api.ts`, which imports `AgentName` and `TabNotFoundError` from `../domain/project`:

```ts
/** Renames tab `paneId` to `name`. Fails with `TabNotFoundError` when no tab has that id. */
readonly renameTab: (paneId: string, name: AgentName) => Effect.Effect<void, TabNotFoundError>
```

`PaneWorkspaceLive` requires `HostPlugins` (`pane-workspace.ts:233`), so `HostPlugins` cannot require `PaneWorkspace`. `ctx.renameTab` is implemented in `host-plugins.ts` over a new `TabRenamer` service (`src/host/services/tab-renamer.ts`): a `Ref<Option<(paneId, name) => Effect<void, TabNotFoundError>>>` that `HostPlugins` reads and `PaneWorkspaceLive` fills with its `renameTab` when it is built, as `WorkspaceFeed` is shared today. Until it is filled, `ctx.renameTab` fails with `TabNotFoundError` (not reachable in practice: `HostPlugins.start()` runs after `PaneWorkspaceLive` is built; the failure keeps the type total). `host-main.ts`, `host-plugins.test.ts` and `pane-workspace.test.ts` provide `TabRenamerLive`; the JSDoc of `makeHostPluginsLive` and `PaneWorkspaceLive`, which list their required services, gain `TabRenamer`. The call is logged at info with the calling plugin's name. A test checks that `ctx.renameTab` renames the tab in the workspace.

`PLUGIN_API_VERSION` (`src/shared/plugin/manifest.ts`) and the `api` of every `plugins/*/plugin.json` go to `0.0.46` (a context member is added; below 1.0.0 a plugin loads only on an exact match). `src/host/plugin-api.ts` additionally exports `TabNotFoundError`, `tabOf`, `EffortLevel`, `agentNameFromTitle` and `isGeneratedAgentName`.

### Shared — `src/shared/domain/agent-name.ts`

```ts
/** Whether `name` has the shape `generateAgentName` produces (`adjective-noun` from the two word lists). Use it to tell a name dia gave a tab from one a user typed. */
export const isGeneratedAgentName: (name: string) => boolean
```

A test checks that every `generateAgentName` output passes it.

### `dia-threads` — `slots.ts` (new, added to `plugin.json` `exports`)

```ts
/** One entry another plugin adds to a thread row's right-click menu. */
export interface ThreadRowMenuEntry extends ListEntryFields {
  readonly label: string
  /** Runs when the user picks the entry on the row of thread `paneId`. */
  readonly onSelect: (thread: { readonly paneId: string }) => void
}
/** The entries added to a thread row's right-click menu, declared by dia-threads. Add one with `addEntry(ctx, ThreadRowMenuSlot, entry)`. */
export const ThreadRowMenuSlot = ListSlot.make<ThreadRowMenuEntry>('threads.row-menu')
```

`dia-threads/plugin.json` gains `"exports": ["slots.ts"]`. `dia-threads/renderer.ts` declares it; `thread-row.tsx` renders the entries, ordered by `order`, as a `ContextMenuGroup` after the Show/Rename group.

### `dia-text-generation` — `plugin.json` and `calls.ts`

`plugin.json`: `"host": "host.ts"`, `"renderer": "renderer.ts"`, `"load": "eager"` (so `AutoTitle` follows from startup), `"api": "0.0.46"`, `"exports": ["calls.ts"]`.

These are plugin calls, not `DiaRpcs`, so `PROTOCOL_VERSION` is unchanged.

```ts
/** The adapter, model and effort that write a thread title. `adapter` is the id of a registered adapter; `model` is a model id of that adapter. */
export const TextGenerationSettings = Schema.Struct({
  adapter: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  effort: EffortLevel
})
/** See {@link TextGenerationSettings}. */
export type TextGenerationSettings = typeof TextGenerationSettings.Type

/** Titling a thread produced no name: no adapter offers text generation, the call failed, or the answer held no usable title. `reason` is a sentence for the log. The thread keeps its name. */
export class TitleNotGenerated extends Schema.TaggedError<TitleNotGenerated>()('TitleNotGenerated', { reason: Schema.String }) {}

/** The saved settings now and after each change; the defaults while nothing is saved. */
export const FollowTextGenerationSettings = Rpc.make('FollowTextGenerationSettings', { payload: {}, success: TextGenerationSettings, stream: true })
/** Saves the settings the next title uses. */
export const SetTextGenerationSettings = Rpc.make('SetTextGenerationSettings', { payload: { settings: TextGenerationSettings } })
/** Titles thread `paneId` from its conversation so far; fails with `TitleNotGenerated` and leaves the name. */
export const RegenerateTitle = Rpc.make('RegenerateTitle', { payload: { paneId: Schema.String }, error: TitleNotGenerated })
```

## Key Data Structures

- `TextGenerationSettings` — stored as `<dataDir>/settings.json` through `Schema.fromJsonString`. A missing or undecodable file reads as `{ adapter: 'dia-claude-code', model: 'haiku', effort: 'low' }` and logs at info (missing) or warning (undecodable).
- A **generated name** is one `isGeneratedAgentName` accepts.

## Internal Decomposition

- **`settings.ts` — `TitleSettings`**: owns the saved `TextGenerationSettings`: read, write, follow. Knows the file and the defaults.
- **`writer.ts` — `TitleWriter`**: owns how a title is made: picks the adapter (saved, else the first registered with text generation and its `defaultModel`), builds the instructions, calls `generate` under `Effect.timeout(Duration.seconds(30))` (a timeout and a `TextGenerationFailed` both become `TitleNotGenerated`), and turns the answer into an `AgentName` (first line, surrounding quotes stripped, `agentNameFromTitle`). `title(conversation: string) => Effect<AgentName, TitleNotGenerated>`.
- **`auto-title.ts` — `AutoTitle`**: owns which threads are titled automatically: follows `RunEvents.subscribe`; on a user `MessageUpdated` for run `R` not yet decided, reads `snapshot(R)`, finds tab `R` with `tabOf` on the latest `ctx.workspace` value (`Result<{ project, tab }, TabNotFoundError>`; a failure means the tab is missing), and skips it when the tab is missing, the tab has an `owner`, or has a name `isGeneratedAgentName` rejects, or when the snapshot holds more than one user message. Otherwise titles it and calls `ctx.renameTab`. It remembers each run it decided for, so the second `MessageUpdated` of the same message does nothing.
- **`host.ts`**: wires the three and serves the calls. `RegenerateTitle` reads the snapshot of `paneId`, joins its user and assistant text (cut to the last 8 000 characters), titles it, and renames the tab.
- **`renderer.ts`**: adds the Settings page `text-generation` ("Text generation", after Adapters) and the `ThreadRowMenuSlot` entry "Regenerate title" (`callHost` `RegenerateTitle`; a failure is logged as a warning).
- **`text-generation-settings.tsx`**: adapter select (adapters from `useAdapters()` with `textGeneration`), model select (`useModelCatalog(adapter)`), effort select listing the selected model's `effortLevels`, disabled when the list is empty. Changing the adapter sets the model to that adapter's first model; changing the model or adapter resets effort to the first listed level, or `low` when the list is empty.
- **Logging**: `TitleWriter` logs the adapter, model and answer length at debug and a rejected answer at warning; `AutoTitle` logs each decision (titled, or skipped with the reason) at debug and a rename at info; `TitleSettings` logs a saved change at info.

## Design Rationale

**Text generation is a capability of the adapter registration, not a member of `AgentBackend`** — an adapter offers it or not, and a consumer picks an adapter by what it offers. `defaultModel` lets the fallback in criterion 8 use a model of the adapter it falls back to, because a saved model id is only meaningful within its own adapter.

**`backend` stays required** — `docs/designs/agent-adapter-registry.md` planned optional capabilities with at least one present. No adapter without sessions exists, so making `backend` optional would add a none case to every session consumer for no adapter (AHA). That design doc and ADR-0086 are updated to say the at-least-one shape waits for such an adapter.

**`instructions` + `input`, not a title-specific call** — the capability is shaped around text generation (Strategic Programming); titling is the first caller and owns its prompt in `TitleWriter`.

**`ctx.renameTab` on the kernel context** — tab names live in `PaneWorkspace`, which plugins cannot reach; renaming from the renderer would make titling depend on an open window. The seam has no dependency and matches the existing `RenameTab` RPC, which has no owner check either. Recorded as ADR-0087, added to the ADR index.

**First-message detection by snapshot count, not by a stored flag** — "exactly one user message" holds only for the first message, so a restart does not re-title an old thread and nothing is persisted. If a second user message is committed before the snapshot is read, the count is 2 and the thread is not titled automatically; "Regenerate title" covers that case. The set of decided runs grows by one string per thread for the life of the Host process; accepted.

**`isGeneratedAgentName` beside `generateAgentName`** — the `adjective-noun` shape stays owned by the generator's module (Information Hiding), so a change to the generator changes the check with it. A worktree-branch name with the same shape is also titled, which is the intended result for an unnamed thread.

## Rejected Alternatives

- **`AgentBackend.generateText`** — every adapter would have to implement it; the user chose a capability.
- **Renaming from the renderer** (`actions.renameTab` after a host call) — titles would only be written while a window is open.
- **A `generated: boolean` on `Tab`** — a workspace schema change and `PROTOCOL_VERSION` bump for a fact derivable from the name.
- **Storing settings in the Host `settings.json`** — plugins must not write it (`hostSettingsOf`); `<dataDir>` is the plugin's own storage.
- **Optional `backend` with at-least-one capability** — see "`backend` stays required".

## Refinement Record

**Round 1 — Applied**
- *Correctness* (1) — `Schema.TaggedErrorClass` does not exist in Effect 4.0.6; `TitleNotGenerated` uses `Schema.TaggedError<T>()(tag, fields)`.
- *Correctness* (2) — `TabNotFoundError` was not exported to plugins; `src/host/plugin-api.ts` exports it, `agentNameFromTitle` and `isGeneratedAgentName`; the member is placed on the shared `HostPluginContext`.
- *Correctness* (3) — a timeout would leave the SDK subprocess running; `generate` runs `query` in `acquireUseRelease` with `query.close()`.
- *Correctness* (4) — `makeClaudeCodeTextGeneration` takes `dataDir`; install resolved with `install.resolve`.
- *Reuse* (5) — effort options come from `thinkingOptions`; haiku's runtime acceptance of `effort` marked unverified and added to criterion 3.
- *Information Hiding* (6) — `isGeneratedAgentName` added beside the generator.
- *Define Errors Out of Existence / prior design* (7) — kept `backend` required and recorded why; registry validates `textGeneration`; PR 1 design doc and ADR-0086 updated.
- *Names* (8) — the settings field is `adapter`, matching `calls.ts`.
- *JSDoc* (9) — JSDoc stated for each new export.
- *Correctness* (10) — the snapshot race and the growth of the decided-runs set recorded as accepted.
- *Correctness* (11) — workspace lookup described as reading the latest stream value.
- *Logging* (12) — logging per module stated.
- *Single statement* (13) — `PROTOCOL_VERSION` statement moved next to the calls.

**Round 2 — Applied**
- *Correctness* (1) — `HostPlugins` requiring `PaneWorkspace` would be a layer cycle; `ctx.renameTab` goes through a `TabRenamer` ref filled by `PaneWorkspaceLive`.
- *Correctness* (2) — `textGeneration` would not reach `useAdapters`; `summaries` and `AdapterSummaryJson` carry it.
- *Correctness* (3) — effort is sent only when the model lists it; the settings page lists the model's efforts.
- *Reuse* (4) — `TextGenerationEffort` replaced by the existing `EffortLevel`.
- *Project rules* (5) — version bump locations and both `plugin.json` changes stated.
- *Reuse* (6) — tab lookup through `tabOf`.
- *Fail Fast* (7) — why an invalid `textGeneration` keeps the adapter registered.
- *Correctness* (8) — MCP-connector suppression marked unverified; criterion 7 proved on options.

**Round 3 — Applied**
- *Correctness / Information Hiding* (1) — the catalog has no synchronous read; `generate` takes the first `catalog.models()` state, and only `Ready` supplies effort levels.
- *POLA* (2) — criterion 3 states when the saved effort is sent.
- *Project rules* (3) — `pane-workspace.test.ts` and the service JSDoc gain `TabRenamer`.
- *Correctness* (4) — `tabOf` returns a `Result`; its failure is the missing-tab skip.
- *Wording* (5) — the unfilled `TabRenamer` case is stated as unreachable.
- *Correctness* (6) — a timeout becomes `TitleNotGenerated`.

Round 3 left no blocker or major finding unapplied; the budget of 3 rounds is spent.
