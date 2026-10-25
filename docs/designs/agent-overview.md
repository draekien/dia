# Agent overview: projects, tabs and the layout plugins

Scope: layer. Replaces the split-pane layout tree with registered projects and their tabs (plan step 1, `docs/plans/2026-10-23-agent-os.md`), adds the agent overview sidebar as renderer plugins (plan step 2, issue #13), and adds an app-wide transcript width setting. One PR.

Governing decisions: ADR-0019, ADR-0023, ADR-0024, ADR-0029, and a new ADR-0031 (renderer plugins fill slots: one root slot, child slots declared by the plugin that fills it). Visual rules: `DESIGN.md` (Agent Overview, Tabs, Status Indicator), updated by this PR.

Every export in the files below carries JSDoc that states its purpose and how to consume it, per `CLAUDE.md`. Every union member is a named `Schema.TaggedStruct` export with a required `_tag`; types are `typeof X.Type`; values are built with `X.make` (`CLAUDE.md`, `docs/reasoning/2026-10-25-schema-union-needs-required-discriminator.md`).

## Success criteria

Confirmed with the user before design. Each maps to a test or to the Verify phase.

1. Projects, their tabs, the project order and the visible tab survive a restart unchanged.
2. Every pane saved before the migration appears as a tab under a project created from its source directory.
3. Registering a directory that is already registered is refused; a directory that is not a git repo registers, and its New agent form has no worktree option.
4. Each row's activity line matches the latest `TodoWrite` `in_progress` item, else the last tool call; needs-input and failed rows show the reason instead.
5. Inside a group, rows sort needs input, failed, working, finished, idle; a status change never moves a project.
6. A collapsed group header shows its most urgent status and its agent count.
7. Search matches agent and project names; status filters combine with search by AND; `Ctrl P` focuses search; arrow keys and `Enter` select a row and show its tab.
8. Dragging a project header, or the keyboard drag, changes the project order, and the order survives a restart.
9. `Ctrl B` shows the status rail: one dot per agent, a divider between projects, a tooltip naming project and agent.
10. With no projects, "Add project" opens the directory picker; a project with no agents offers "New agent".
11. The content header shows `project / agent`.
12. The transcript column is centred, capped at the chosen width, fills a narrower content area, and the setting survives a restart.
13. The impeccable finish review has no open material findings against `DESIGN.md`.
14. `docs/prds/mvp.md` success criteria hold, reading "pane" as "tab".

## Settled product decisions

From the shape and alignment rounds; the design must not reopen them.

| Decision | Value |
|---|---|
| Status | Five states: needs input (amber, pulses), failed (red, pulses), working (neutral slow pulse), finished (green, steady until the tab is shown), idle (hollow ring) |
| Row second line | Needs input and failed: the reason. Otherwise the activity line |
| Sidebar header | Search input (`Ctrl P`), filter icon button (popover: status checkboxes, "Show archived agents", "Hide projects with no matches", "Clear filters"), add-project icon button (opens the directory picker) |
| Reorder | Drag a project header; keyboard: `Space` lift, `↑`/`↓` move, `Space` drop, `Esc` cancel; a live region announces the new position |
| Project menu | New agent, Reveal in Explorer, Remove project… |
| Rail | `Ctrl B`; one dot per agent; hairline divider between projects; Meta first |
| Search and filter | Meta group hidden while either applies; groups open while searching; counts read `n of total` |
| Agent name | Optional in the New agent form; blank gets a generated two-word slug, shared with the worktree branch when one is created; rename with `F2` or the row menu |
| New agent | Opens the creation form in the content area with the project fixed; no first-message field; "Start agent" shows the new tab with its composer focused |
| Remove project | Allowed with agents. A dialog lists every agent, worktree and transcript that will be removed; typing the project name enables "Remove"; a progress list shows each item as it is removed. Each agent's worktree and transcripts are deleted; the project directory is never touched. When an item fails, "Remove again" retries the failed items and "Remove anyway" drops the project and leaves them on disk |
| Transcript width | `narrow`, `default`, `wide`; each a maximum width; one app-wide setting; changed from the content header, the command palette, and settings |

## Interface

### Shared domain — `src/shared/domain/project.ts`

```ts
export const ProjectId = Uuid.pipe(Schema.brand('ProjectId'))
/** Decoded from trimmed input: the form trims before decoding, because `Schema.Trimmed` rejects rather than trims. */
export const AgentName = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(64)), Schema.brand('AgentName'))

export const Project = Schema.Struct({
  projectId: ProjectId,
  directory: Schema.String,        // absolute path, first spelling registered
  directoryKey: Schema.String,     // comparison key, computed by the Host
  displayName: Schema.String,      // directory base name at registration
  isGitRepo: Schema.Boolean
})

/** The pane id is `config.paneId` (ADR-0023 keeps "pane" in code); a tab has no second copy. */
export const Tab = Schema.Struct({
  name: AgentName,
  config: PaneConfig,
  sessionId: Schema.optional(SessionId),
  archived: Schema.Boolean
})

export const ProjectEntry = Schema.Struct({ project: Project, tabs: Schema.Array(Tab) })

/** Array order is the user's project order; no separate position field can disagree with it. */
export const Workspace = Schema.Struct({
  projects: Schema.Array(ProjectEntry),
  visibleTab: Schema.NullOr(Uuid)
}).pipe(Schema.check(uniqueDirectoryKeys, uniquePaneIds, visibleTabExistsAndIsNotArchived))
```

`uniqueDirectoryKeys` compares the stored `Project.directoryKey` fields, so the check runs the same in the Host, preload and renderer. The Host computes the key at registration and migration with `directoryKey(path, separator)` in `src/host/services/project-directory.ts`, which also holds `probeProject` (the directory and `isGitRepo` checks): resolved, trailing separators stripped, lower-cased when the path separator is `\`. `src/shared` holds no path logic (ADR-0013; `tsconfig.shared.json` has `"types": []`).

`visibleTab` is `null` while the content area shows no tab: the New agent form, or the plugins page. On load, a `null` with at least one non-archived tab shows the first one.

`src/shared/domain/workspace.ts` holds the pure operations, each returning `Result` with a typed error and never a `Workspace` that fails the checks: `addProject`, `moveProject(projectId, toIndex)`, `removeProject` (sets `visibleTab` to the first non-archived tab of the next project, else of the previous one, else `null`, when the removed project holds it), `addTab` (sets `visibleTab` to the new tab, so `createTab` emits one `WorkspaceChanged` that already shows it), `renameTab`, `selectTab(PaneId | null)`, `updateTabConfig`, `recordSession`, `tabOf(paneId)`, `moveVisibleTabOff(projectId)` (the `visibleTab` rule of `removeProject`, applied before the project's agents stop) and `withDefaultVisibleTab` (the on-load rule above).

Pane ids are `Uuid` throughout (`Workspace.visibleTab`, `SelectTab`, `AgentSummary.paneId`). The `PaneId` type alias (`type PaneId = string`, `pane-tree.ts:6`) moves to `pane.ts` when `pane-tree.ts` is deleted.

Errors that cross the RPC — `ProjectAlreadyRegisteredError`, `DirectoryNotFoundError`, `ProjectNotFoundError`, `TabNotFoundError`, `WorktreeUnavailableError` — are `class X extends Schema.TaggedError<X>()('X', {...})` (`node_modules/effect/src/Schema.ts:16653`), so each can be an RPC `error` schema.

### Shared domain — `src/shared/domain/agent-summary.ts`

```ts
export const Todo = Schema.TaggedStruct('Todo', { text: Schema.String })
export const ToolUse = Schema.TaggedStruct('ToolUse', { tool: Schema.String, target: Schema.NullOr(Schema.String) })
export const NoActivity = Schema.TaggedStruct('NoActivity', {})
export const Activity = Schema.Union([Todo, ToolUse, NoActivity])

export const StatusNeedsInput = Schema.TaggedStruct('StatusNeedsInput', { reason: Schema.String })
export const StatusFailed = Schema.TaggedStruct('StatusFailed', { reason: Schema.String })
export const StatusWorking = Schema.TaggedStruct('StatusWorking', {})
export const StatusFinished = Schema.TaggedStruct('StatusFinished', {})
export const StatusIdle = Schema.TaggedStruct('StatusIdle', {})
export const AgentStatus = Schema.Union([StatusNeedsInput, StatusFailed, StatusWorking, StatusFinished, StatusIdle])

export const AgentSummary = Schema.Struct({ paneId: Uuid, status: AgentStatus, activity: Activity })

/** The summary after one pane event. Pure. */
export const foldSummary: (summary: AgentSummary, event: IpcEvent) => AgentSummary
/** The summary once the user has shown the tab: `StatusFinished` becomes `StatusIdle`; other statuses are unchanged. Used inside `AgentSummaries`. */
export const markShown: (summary: AgentSummary) => AgentSummary
/** Overview order: needs input, failed, working, finished, idle. */
export const statusRank: (status: AgentStatus) => number
```

`foldSummary` rules:

| Event | Effect |
|---|---|
| `PaneUserMessagesSent` | status `StatusWorking` |
| `PaneToolCallStarted` | activity `ToolUse { tool, target: null }`, unless the current activity is a `Todo` |
| `PaneToolCallCompleted`, tool `TodoWrite` | activity `Todo { text }` from the `in_progress` item's `activeForm`, else its `content` (`TodoWrite` input `todos[].{content, status, activeForm}`, `sdk-tools.d.ts:771`); when no item is `in_progress`, `ToolUse { tool: 'TodoWrite', target: null }` |
| `PaneToolCallCompleted`, other tool | activity `ToolUse { tool, target }`, `target` from `toolTarget(tool, input)` (`file_path`, `command`, `pattern`, `url`, `path`, in that order), unless the current activity is a `Todo` |
| `PaneAttentionChanged` `AwaitingPermission` | status `StatusNeedsInput { reason }`: `Allow <tool> <target>?`, the first question's text, or `Review the plan` (`pane-supervisor.ts:285-306` raises it for all three) |
| `PaneAttentionChanged` `Idle` while `StatusNeedsInput` | status `StatusWorking` (a resolved request or an interrupt, `pane-supervisor.ts:423-479`) |
| `PaneAttentionChanged` `Completed` | status `StatusFinished` |
| `PaneAttentionChanged` `Errored` / `Crashed` | status `StatusFailed { reason: attention.error.message }` |
| any other | unchanged |

An interrupted turn ends with `Completed`: the adapter rewrites the expected abort to `TurnCompleted` (`plugins/claude-code/session.ts:531-538`), so the row reads finished. A steer shows finished until its `PaneUserMessagesSent` sets working again. `Completed` settling to `Idle` after 3 s in the supervisor (`pane-supervisor.ts:363-369`) does not end `StatusFinished`; only `markShown` or a new user message does.

### Shared domain — names and settings

`src/shared/domain/agent-name.ts`: `AGENT_NAME_ADJECTIVES`, `AGENT_NAME_NOUNS` (moved from `plugins/worktrees/worktree-slug.ts`) and `generateAgentName: Effect<AgentName>`. `src/host/plugin-api.ts` re-exports both lists, so `plugins/worktrees` imports them from `@dia/plugin`; the existing `plugin-modules.test.ts` case "resolves @dia/plugin inside a plugin to the module the Host was given" covers that runtime resolution, so no new case is added.

`src/shared/domain/transcript-width.ts`: `TranscriptWidth = Schema.Literals(['narrow', 'default', 'wide'])`, `TRANSCRIPT_WIDTHS` (its literals, in that order), `DEFAULT_TRANSCRIPT_WIDTH = 'default'`.

### Host — `PaneWorkspace`

`PaneWorkspace` keeps its name and its session lifecycle (`resumePane`, `ensureLive`, `getPaneHistory`). Its tree state is replaced by `Workspace`:

```ts
readonly getWorkspace: Effect<Workspace>
readonly registerProject: (projectId: ProjectId, directory: string) => Effect<void, ProjectAlreadyRegisteredError | DirectoryNotFoundError>
readonly moveProject: (projectId: ProjectId, toIndex: number) => Effect<void, ProjectNotFoundError>
readonly removeProject: (projectId: ProjectId, force: boolean) => Stream<RemovalProgress, ProjectNotFoundError>
readonly createTab: (request: CreateTabRequest, onEvent) => Effect<void, ProjectNotFoundError | WorktreeUnavailableError | WorktreeCreateError | WorktreeReattachError>
readonly renameTab: (paneId: PaneId, name: AgentName) => Effect<void, TabNotFoundError>
readonly selectTab: (paneId: PaneId | null, onEvent) => Effect<void, TabNotFoundError>   // persists visibleTab, resumes a cold pane
readonly setThinkingLevel: (paneId: PaneId, level: ThinkingLevel) => Effect<void, TabNotFoundError>
readonly setPermissionMode: (paneId: PaneId, mode: PermissionMode) => Effect<void, TabNotFoundError>
```

Mutations return `void`: the only source of workspace state for clients is `WorkspaceChanged`, published before the mutation replies (Command-Query Separation). Each mutation publishes it through `EventHub`, so `PaneWorkspace` depends on `EventHub`, and on `HostPlugins` to reach the worktrees plugin for removal.

`PaneWorkspace` owns directory checks and does not depend on the worktrees plugin. `isGitRepo` is `FileSystem.exists(<directory>/.git)` (a worktree's `.git` is a file, so `exists`, not a directory test). `registerProject` fails with `DirectoryNotFoundError` when `fs.stat` shows no directory. Migration uses the same check; a missing source directory gives `isGitRepo: false` and still creates the project, so no saved pane is dropped (criterion 2).

`registerProject` is idempotent on a repeated `projectId` with the same `directoryKey`: it returns the workspace unchanged, so a resent request after a reconnect does not fail. A different `projectId` for a registered `directoryKey` fails with `ProjectAlreadyRegisteredError`.

`CreateTabRequest` (in `project.ts`, with `RegisterProjectError`; the removal schemas are in `project-removal.ts`) is a `Schema.Struct`: `{ projectId, paneId, name: Schema.NullOr(AgentName), model, thinkingLevel, permissionMode: StartupPermissionMode, useWorktree: Schema.Boolean }`. `useWorktree` with a project whose `isGitRepo` is false fails with `WorktreeUnavailableError`; the form never offers it, so only a stale client hits it. With a blank name and a worktree, the worktree is created first through the unchanged `GitOps.createWorktree` and the tab is named `info.branch` without its `dia/` prefix, so the name matches the branch and `findAvailableWorktreeName`'s clash check (`plugins/worktrees/git-ops.ts:36-60`) still applies. With a blank name and no worktree, the name is `generateAgentName`.

The permission-mode path that today emits `LayoutChanged` through `onEvent` emits `WorkspaceChanged`.

Every mutation applies its pure `workspace.ts` operation to the workspace as it is at that moment, with `Ref.modify`, then saves; mutations are serialised by one semaphore, separate from `sessionStartLock`. `createTab` runs `openPane` first and applies `addTab` afterwards, never to a snapshot read before `openPane` (the current `createPane` reads the tree before `openPane` and writes after it, `pane-workspace.ts`). A project being removed is marked removing in memory. `createTab` and `selectTab` for any of its tabs fail with `ProjectNotFoundError` / `TabNotFoundError` before they open or resume a pane; `ensureLive` skips such a tab without failing. When `visibleTab` is one of its tabs, `removeProject` first moves `visibleTab` per the pure `removeProject` rule, before the first `closePane`.

`removeProject` streams `RemovalProgress`, a union of `Removing { item }`, `Removed { item }`, `RemoveFailed { item, reason }` and `ProjectRemoved`, where `item` is a union of `AgentItem { paneId, name }`, `WorktreeItem { path }` and `TranscriptItem { sessionId }`. Per agent:

1. A live pane: `PaneSupervisor.closePane`. It ends the outbound queue and joins the subscriber before closing the scope (`pane-supervisor.ts:540-549`), so a turn in flight stops cleanly. Its scope finalizer removes the worktree and only logs a failure (`pane-supervisor.ts:597-603`).
2. A cold pane with a worktree: `resolveGitOps(registry)`, then `GitOps.removeWorktree`. When the worktrees plugin is not loaded (`resolveGitOps` is `none`, `worktrees-seam.ts:82-97`), the `WorktreeItem` is `RemoveFailed { reason: 'Load the worktrees plugin to remove this worktree' }`, and "Remove again" retries it once the plugin is loaded.
3. Either way, a `WorktreeItem` is reported `Removed` only once `fs.exists(path)` is false, because `removeWorktree` returns normally when git exits non-zero (`plugins/worktrees/git-ops.ts:107-136`, `docs/reasoning/2026-10-24-worktree-remove-fails-on-quit-leaves-empty-directory.md`); otherwise `RemoveFailed`.
4. A tab with a `sessionId`: `AgentBackend.deleteSession(sessionId)`.

A failed item is reported and the rest continue. The project is dropped and the workspace saved when every item succeeded. When any item failed, the dialog shows each failure's reason and offers "Remove again" (`force: false`) and "Remove anyway" (`force: true`). "Remove again" runs every item again; each step succeeds when its item is already gone, so only the failed items do work. With `force`, agents are stopped, the project is dropped, and worktrees and transcripts are left on disk.

`AgentBackend` (`src/host/session/agent-backend.ts`) gains `deleteSession: (sessionId: SessionId) => Effect<void, SessionDeleteError>`. It succeeds when the transcript no longer exists, including when it was never written. The `claude-code` adapter calls the SDK's `deleteSession(sessionId)` with no `dir`, which removes `{sessionId}.jsonl` from the local projects directory (`sdk.d.ts:500-515`), and maps its "session is not found" throw to success. A retry is therefore idempotent.

### Host — `AgentSummaries` (`src/host/services/agent-summaries.ts`)

```ts
readonly getAll: () => Effect<ReadonlyArray<AgentSummary>>
```

Subscribes to `EventHub` and handles every event in one fiber, in order:

- a pane event is folded with `foldSummary`; when the result is `StatusFinished` and the pane is the current `visibleTab`, `markShown` is applied in the same step, so a tab on screen never shows finished;
- `WorkspaceChanged` updates the `visibleTab` it tracks; when that pane is `StatusFinished`, `markShown` is applied; summaries and saved activity of panes absent from the workspace are dropped;
- `AgentSummaryChanged` (its own output) is ignored.

It publishes `AgentSummaryChanged { summary }` when a summary changes. No RPC handler calls it.

It persists each pane's `activity` to `<userData>/activity.json` through `PersistenceService.saveActivity` / `loadActivity`, `ACTIVITY_SAVE_DELAY` (`Duration.seconds(2)`) after the first unsaved change, and flushes in its scope finalizer. It seeds summaries from that file at start, with status `StatusIdle`. `workspace.json` holds no activity, so `WorkspaceChanged` fires only for structural changes.

### Host — persistence and settings

`PersistedWorkspace` becomes `Schema.Struct({ version: Schema.Literal(2), workspace: Workspace })`. On load: decode version 2; otherwise decode the version 1 shape `{ tree, panes }` and migrate:

- panes are grouped by `directoryKey(config.worktree?.sourceRepo ?? config.cwd)`; each group becomes a project, in the order its first pane appears in the tree, keeping the first spelling as `directory`; `isGitRepo` is detected when the project is created;
- the tab name is the worktree slug when `config.worktree.branch` is `dia/<slug>`, else `generateAgentName`;
- pending leaves are dropped; `visibleTab` is the first migrated tab;
- the version 1 file is copied to `workspace.v1.json`, then the migrated workspace is saved as version 2 at once, so the next launch does not migrate again with new project ids and agent names.

A migrated file always yields a valid `Workspace`. A file that decodes as neither version is handled as today: logged, and the workspace starts empty.

`SettingsStore` gains `getTranscriptWidth` / `setTranscriptWidth`.

### RPC — `src/shared/ipc/rpc.ts`, `PROTOCOL_VERSION` 7 → 8

| Removed | Added |
|---|---|
| `SplitPane`, `ClosePane`, `CreatePane`, `FocusPane`, `GetInitialLayout`, and `GetLastDirectory` and `RecordChosenDirectory` (their only caller was the old form's directory picker; `SettingsStore` loses `lastDirectory`); event `LayoutChanged` | Queries (typed `success` and `error`, `Rpc.make(name, { payload, success, error })`): `GetWorkspace`, `RegisterProject { projectId, directory }` (error `RegisterProjectError`), `RemoveProject { projectId, force }` (streaming success `RemovalProgress`), `GetAgentSummaries`, `GetTranscriptWidth` |
| | Commands (`withRequestId`): `MoveProject { projectId, toIndex }`, `CreateTab`, `RenameTab { paneId, name }`, `SelectTab { paneId: Schema.NullOr(Uuid) }`, `SetTranscriptWidth { width }` |
| | Events: `WorkspaceChanged { workspace }`, `AgentSummaryChanged { summary }` (global, never replayed) |

`RegisterProjectError` is `Schema.Union([ProjectAlreadyRegisteredError, DirectoryNotFoundError])`. With `stream: true`, `RemoveProject`'s `error` is the stream's error schema (`effect/unstable/rpc/Rpc.ts:983-986`). `CommandDeduper.accept(scopeId, commandId)` takes a `scopeId`: the `paneId` for pane commands, the `projectId` for project commands, `'app'` for app settings. No wrapper field reuses a payload field name; each new command gets a test that its payload reaches the handler unchanged. `PaneCreateFailed` stays for `CreateTab`.

Main gains `CHANNEL.revealPath` (`shell.showItemInFolder`); the handler reveals the path only after `fs.stat` confirms it is a directory.

### Preload and `DiaApi`

`DiaApi` (`contract.ts`) and `makeHostApi` gain `getWorkspace`, `registerProject`, `moveProject`, `removeProject`, `createTab`, `renameTab`, `selectTab`, `getAgentSummaries`, `getTranscriptWidth`, `setTranscriptWidth`, `onWorkspaceChanged`, `onAgentSummaryChanged` and `onAgentSummariesReplaced`. They lose `splitPane`, `closePane`, `createPane`, `focusPane`, `getInitialLayout`, `chooseDirectory` and `onLayoutChanged`.

- Every value that crosses `contextBridge` is plain data: the bridge drops prototypes, so an `Option` or `Result` arrives without its `_tag` and a typed-error instance loses its fields (`docs/reasoning/2026-10-25-context-bridge-drops-option-and-result.md`). Optional fields are therefore `Schema.NullOr`, not `Option`.
- `registerProject(projectId, directory): Promise<RegisterProjectRefusal | null>` resolves `null` once registered. `catchTags` turns each typed refusal into its encoded form (`RegisterProjectRefusal = typeof RegisterProjectError.Encoded`) in the success channel, so `query`'s retry and `orDie` (`host-api.ts`, `query`) apply only to transport errors.
- `removeProject(projectId, force, onProgress: (progress: RemovalProgress) => void): Promise<void>` runs `client.RemoveProject({ projectId, force })` with `Stream.runForEach` and calls `onProgress` per item. `ProjectNotFoundError` is logged and resolves, because a project already gone is removed. It is not retried when the connection drops: a rejected promise puts the dialog in a "Connection lost" state with "Check again", which sends the removal again without `force`. The dialog closes when `ProjectRemoved` arrives or when the project leaves the workspace, which the reconnect refresh reports. A callback, not an `AsyncIterable`, because `contextBridge.exposeInMainWorld` (`src/preload/index.ts:123`) does not carry `Symbol.asyncIterator` (unverified in the repo; the existing bridge uses callbacks only, e.g. `onUpdateStatusChanged`).
- `revealPath(directory)` is implemented in `src/preload/index.ts` with `ipcRenderer`, and listed in the `HostApi` `Omit` in `host-api.ts`. `refreshLayoutAfterReconnect` (`host-api.ts:127-134`) becomes `refreshAfterReconnect`, run on every resubscribe after the first: it calls `GetWorkspace` and `GetAgentSummaries` and dispatches `WorkspaceChanged` and `AgentSummariesReplaced { summaries }`, a renderer-only event. After a Host restart every pane is cold and `AgentSummaries` seeds each summary as `StatusIdle` with its saved activity. The renderer sends `SelectTab` for `visibleTab` once at start and once after each `AgentSummariesReplaced`, which resumes the shown tab, as `FocusPane` does today.

### Renderer kernel — slots and the plugin API

`src/renderer/src/plugin-api.ts`, imported by renderer plugins as `@dia/renderer-plugin`:

```ts
export const ROOT, SIDEBAR, MAIN, MAIN_HEADER: SlotName
/** Fills `name` with `component` for the lifetime of the plugin's scope. Fails when another plugin fills it. */
export const fillSlot: (ctx: PluginServices, name: SlotName, component: ComponentType) => Effect<void, ServiceKeyTakenError, Scope>
/** Renders the slot's filler, else the kernel default for `name`, else `empty`. */
export function Slot(props: { name: SlotName; empty?: ReactNode }): ReactNode
export function useWorkspace(): Workspace | undefined
export function useAgentSummaries(): ReadonlyMap<PaneId, AgentSummary>
export function useView(): View          // TabView { paneId } | NewAgentView { projectId } | FirstRunView | EmptyProjectView
export function useTranscriptWidth(): readonly [TranscriptWidth, (width: TranscriptWidth) => void]
export const actions: {
  selectTab, newAgent, cancelNewAgent, registerProject, moveProject, renameTab, removeProject, revealProject, openPluginsPage
}
/** Kernel UI a plugin renders; a plugin file imports no `@renderer/*` path. */
export { StatusIndicator, statusLabel }   // the renamed PulseIndicator, taking an AgentStatus
export * from './components/ui/...'       // button, checkbox, context-menu, dialog, input, popover, scroll-area, separator, tooltip
export { cn }
```

`actions.newAgent` and opening the plugins page send `SelectTab { paneId: null }`; cancelling the form sends `SelectTab` for the previous tab, and closing the plugins page sends it for the tab shown before.

`fillSlot` stores the component under the service key `slot:<name>` through `ctx.provide`, so single occupancy, `ServiceKeyTakenError` and removal on scope close come from `makePluginRegistry` (`plugin-registry.ts:290-304`). `slot:<name>` is not exported; a plugin only calls `fillSlot`. `PluginRegistry` gains `changes: Stream<string>`, the keys whose provider changed, emitted from both the acquire and the release inside `provide` (`plugin-registry.ts:292-304`); the existing `onChange` reports `PluginInfo` differences only, so a reload under the same key would otherwise go unseen. `main.tsx` sets the kernel defaults with `setKernelDefault`, passes the registry that `startRendererPlugins` resolves to `setPluginRegistry` (both in `src/renderer/src/lib/slots.ts`), then calls `renderApp`, which provides `appRegistry` (the atom registry) through `RegistryContext`. `Slot` reads the current filler with `inject` on first render (an `Effect` whose body is `Effect.sync`, `plugin-registry.ts:273-275`, so `Effect.runSync` is safe) and subscribes to `changes` afterwards; emissions during `registry.start()` need no subscriber, because the first render reads the settled state.

Kernel defaults: `MAIN` → `TabContent`; `MAIN_HEADER` → `TabHeader`. `ROOT` and `SIDEBAR` have none. `app.tsx` renders `<AppHeader/>` then `<Slot name={ROOT} empty={<NoLayoutPlugin/>}/>`; the plugins page stays as today.

`TabContent` renders by `useView()`: `TabView` → `<Slot name={MAIN_HEADER}/>` and the tab's `Pane`; `NewAgentView` → `PaneCreationForm` for that project; `FirstRunView` → the "Add a project" screen; `EmptyProjectView` → a prompt with "New agent" for the first project. `TabHeader` shows `project / agent`, the worktree chip, and the width button.

State: `workspaceAtom` is written only by `GetWorkspace` and `WorkspaceChanged`. `agentSummariesAtom` (`GetAgentSummaries`, then `AgentSummaryChanged` and `AgentSummariesReplaced`), `transcriptWidthAtom` (the `send-mode-atom.ts` pattern). `viewAtom`, in priority order: the renderer-local `NewAgentView { projectId }` while the form is open; else `TabView { paneId }` when `visibleTab` is not `null`; else `FirstRunView` when `projects` is empty; else `EmptyProjectView`. The renderer clears `NewAgentView` when a `WorkspaceChanged` arrives whose `visibleTab` is not `null` and differs from the one before the form opened, and on cancel (`actions.cancelNewAgent`).

`Pane`: its header (cwd chip, split and close buttons) is removed; the transcript, interaction cards and composer sit in one column, `mx-auto w-full` with a maximum width from `transcriptWidthAtom`: `narrow` `max-w-2xl`, `default` `max-w-3xl`, `wide` `max-w-5xl`. The command palette changes the width with a segmented row. After "Start agent", the new tab mounts with its composer focused; showing a tab any other way leaves focus where it is, so arrow-key navigation in the sidebar keeps working. `PaneCreationForm`: takes `projectId`, drops the directory picker, adds the optional name (trimmed before decoding), shows the worktree switch only for a git project. `PulseIndicator` takes an `AgentStatus` instead of an `AttentionState`.

### Build wiring

- `@dia/renderer-plugin` is declared in `tsconfig.base.json`, `tsconfig.web.json` (its own `paths`, which replaces the base's, so it restates the existing aliases), `tsconfig.test.json` `paths` (which also replaces the base's), the renderer block of `electron.vite.config.ts`, and `vitest.config.ts`.
- A renderer plugin's entry is `renderer.ts`; every other file that imports `@dia/renderer-plugin` is `.tsx`. `plugins/**/*.tsx` joins `tsconfig.web.json` `include`; `plugins/**/*.test.tsx` joins `tsconfig.test.json` and `vitest.config.ts` `include`. Every non-React `.ts` module a web-project file imports (for example `plugins/agent-overview/overview.ts`) is listed in the `tsconfig.web.json` `include` by path, because the web project is `composite` and an import outside its `include` is error TS6307. Such modules import only `@shared/*`.
- `src/renderer/src/index.css` adds `@source '../../../plugins';` so Tailwind scans plugin classes (unverified that auto-detection misses them; the build check confirms it).

### Plugins

`plugins/layout` (feature, eager, renderer only): fills `ROOT` with the frame — a sidebar column sized to its content and the content area. Renders `<Slot name={SIDEBAR} empty={<NoSidebarPlugin/>}/>` and `<Slot name={MAIN}/>`.

`plugins/agent-overview` (feature, eager, renderer only): fills `SIDEBAR`. Owns search, filters, group collapse, the rail and their keyboard bindings (`Ctrl P`, `Ctrl B`, arrows, `Enter`, `F2`), drag reorder, the project menu, and the remove-project dialog. Group collapse and rail state are kept in `localStorage` under `dia.agent-overview.collapsed` and `dia.agent-overview.rail`. The window key listener and the drag sensors belong to the `AgentOverview` component, so they go when the slot empties. Drag uses `@dnd-kit/core` 6 and `@dnd-kit/sortable` 10; the keyboard sensor's codes are set so `Space` lifts and drops and `Enter` toggles a group. The Meta group is a static header reading "No open proposals" until plan step 6 adds proposals; it has no agents, so the rail shows nothing for it. With the plugin unloaded, `SIDEBAR` shows `NoSidebarPlugin` and `MAIN` is unaffected. The plugins page lists and unloads Host plugins only, so the user cannot unload a renderer plugin from it yet. Pure view logic in `plugins/agent-overview/overview.ts`: `buildOverview(workspace, summaries, filters): ReadonlyArray<OverviewGroup>` (ordered groups, ordered rows, most urgent status, `n of total` counts) and `navigationOrder(groups, collapsed)`. `OverviewFilters`, `OverviewGroup` and `OverviewRow` are schemas in that file.

## Internal decomposition

- **Workspace model** (`project.ts`, `workspace.ts`) — owns which projects and tabs exist, their order, and which tab is visible.
- **Summary model** (`agent-summary.ts`) — owns how pane events become a status and an activity line.
- **PaneWorkspace** (Host) — owns persistence of the workspace and the agent sessions behind tabs.
- **AgentSummaries** (Host) — owns the current summary of every tab and its saved activity.
- **Slot rendering** (`plugin-api.ts`, `Slot`, `fillSlot`) — owns which component draws each region and the kernel defaults.
- **Layout plugin** — owns the frame.
- **Agent overview plugin** — owns how the overview presents and filters the workspace.
- **TabContent / Pane** (kernel) — owns the visible tab's content and the transcript column.

## Design rationale

**Slots reuse service keys, behind `fillSlot`.** The registry already gives single occupancy, scope-bound removal, taken-key errors and reopening of dependants; a separate slot registry would duplicate all four. `fillSlot` hides the key format and types the component, so a plugin depends only on what a slot is (Information Hiding).

**Kernel defaults for `MAIN` and `MAIN_HEADER`.** The chat is still kernel code (issue #9, `plugins/chat`). A plugin cannot import `src/`, so it cannot render `TabContent`; the kernel resolves the default when no plugin fills the slot. The later chat plugin fills `MAIN`, with no change to the layout plugin.

**Plugins talk through kernel state, not to each other.** The sidebar and `MAIN` agree on the visible tab only through `useView()` and `actions.selectTab` (Law of Demeter). The Host persists `visibleTab`, so a restart and a second client agree too.

**The Host owns summaries.** Renderer chat atoms exist only while mounted, and transcript history carries no tool parts, so a renderer derivation is wrong for every tab not opened since launch. `foldSummary` and `markShown` are pure, so they are tested without a process.

**Activity is stored apart from the workspace.** It changes on every tool call; in `workspace.json` it would rewrite the whole file and broadcast `WorkspaceChanged` each time. `activity.json`, written on a trailing debounce and flushed at shutdown, keeps the last line for a restart.

**Queries for project registration and removal.** A command is fire-and-forget (`host-api.ts`, `command`), so a refusal could never reach the form (criterion 3). A query whose typed refusal is caught into the success channel carries it without being retried; a client-generated `projectId` makes a resend after a dropped connection idempotent.

**`AgentSummaries` reads the visible tab from the event stream.** Folding `WorkspaceChanged` and pane events in one fiber orders a tab switch and a `Completed` without a handler calling two services in sequence (Avoid Temporal Decomposition).

**Order is array position.** A `position` field could duplicate or skip values; the array cannot (Define Errors Out of Existence). For the same reason the tab's pane id exists only as `config.paneId`.

**Archived tabs are in the model now.** The overview renders the "Archived" list and "Show archived agents" today, so `Tab.archived` exists from the first version 2 file and step 3 needs no migration.

## Rejected alternatives

- **Kernel-owned frame with named slots** — ADR-0019 rejected a fixed core with extension points.
- **One `layout` key with no child slots** — the user chose child slots, following `deepseek-ai/deepseek-harness` at `22ddee3` (`docs/subsystems/slots.md:23`, `packages/client/ui-layout/README.md:30`).
- **Kernel-first sidebar** — departs from issue #13.
- **Renderer-derived summaries** — wrong for tabs not opened since launch.
- **Activity in `Tab`** — rewrites `workspace.json` on every tool call.
- **A pre-generated slug passed to `GitOps.createWorktree`** — skips its clash check and changes the seam.
- **A first-message field in the New agent form** — dropped by the user.
- **A separate slot registry** — duplicates the service-key registry.

## Docs this PR changes

- New `docs/adr/0031-renderer-plugins-fill-slots.md`; index row.
- `DESIGN.md`: Status Indicator (five states), Agent Overview (header, filter, drag, rail), Tabs (content header slot), transcript width.
- `docs/plans/2026-10-23-agent-os.md`: steps 1 and 2 done; `docs/plans/2026-10-22-plugin-platform.md`: the slot decision answers its open question; issue #9 layout item.
- `docs/prds/agent-os.md`: the reorder open question is answered (drag).

## Open for implementation

None. The drag library (`@dnd-kit`) and the three widths are recorded above.

## Refinement Record

### Round 1

**Applied**
1. *Correctness* (blocker) — project registration was a fire-and-forget command, so a refusal never reached the UI; `RegisterProject` and `RemoveProject` are queries with typed errors and a client-generated `projectId`.
2. *Correctness* (blocker) — `Finished` could not end: `SelectTab` is not an `IpcEvent`, and the visible tab never gets one; added `markShown` and the visible-tab rule.
3. *Correctness* (blocker) — `Slot` had no path to the registry, the alias was declared in one config, plugin `.tsx` files were outside every tsconfig, and Tailwind did not scan `plugins/`; added the registry ref and the build wiring section.
4. *Information Hiding* (major) — `slotKey` exposed that slots are service keys; replaced by `fillSlot`.
5. *Correctness* (major) — removal stopped agents and then removed worktrees a second time, and transcripts had no delete path; per-agent order, `AgentBackend.deleteSession`.
6. *Correctness* (major) — a pre-generated slug cannot be passed to `GitOps.createWorktree`; a blank name takes the created branch's slug.
7. *Correctness* (major) — the shared word lists were imported through `@dia/plugin` without an export; `plugin-api.ts` re-exports them.
8. *Correctness / Minimize Complexity* (major) — `Tab.lastActivity` rewrote `workspace.json` per tool call; activity moved to `activity.json` in `AgentSummaries`.
9. *Correctness* (major) — `Schema.Option` does not encode to JSON; `Schema.OptionFromNullOr`.
10. *Correctness* (major) — directory uniqueness had no comparison rule, and migration could produce an invalid workspace; `directoryKey`.
11. *Correctness* (major) — `CommandDeduper` is keyed by pane; `accept(scopeId, commandId)`.
12. *Correctness* (major) — the reconnect re-fetch and `DiaApi` changes were missing; preload section.
13. *Project rule: schema-derived types, `.make`* (major) — hand-declared unions and records; all are named `TaggedStruct` schemas.
14. *Correctness* (major) — the failure reason is `error.message`; the interrupt open question is answered (`session.ts:531-538`).
15. *Correctness* (major) — `PaneWorkspace` signatures still returned `PaneNode`; updated.
16. *Define Errors Out of Existence* (minor) — `Tab.paneId` duplicated `config.paneId`; removed.
17. *Fail Fast* (minor) — `useWorktree` on a non-git project was ignored; `WorktreeUnavailableError`.
18. *Names* (minor) — `Idle` and `Tab` collided; `Status*` members, `TabView`/`NewAgentView`/`FirstRunView`, `TabContent`.
19. *Project rule: JSDoc* (minor) — stated for every export.
20. *Correctness* (minor) — the streaming removal bypassed the resend path; `AsyncIterable`, not retried, idempotent "Remove" again.

**Rejected** — none.

**Escalated** — none.

### Round 2

**Applied**
1. *Correctness* (blocker) — `AsyncIterable` cannot cross `contextBridge`; `removeProject` takes an `onProgress` callback.
2. *Correctness, ADR-0013* (blocker) — `directoryKey(path, NodeJS.Platform)` does not typecheck in `src/shared` and the schema check has no platform; the key is a stored field computed in the Host.
3. *Correctness* (blocker) — `Schema.TaggedErrorClass` does not exist; `Schema.TaggedError<X>()` (`Schema.ts:16653`).
4. *Correctness* (blocker) — `query` retries every error for 30 s, then dies; typed-error queries end in `Effect.result`.
5. *Project rule: path aliases* (blocker) — `tsconfig.test.json` paths, and TS6307 for pure plugin `.ts` files in the composite web project.
6. *Correctness* (major) — the SDK `deleteSession` throws when the transcript is missing; `deleteSession(sessionId)` maps not-found to success.
7. *Correctness* (major) — one persistent failure blocked removal forever, and a worktree could be reported removed while on disk; "Remove again", "Remove anyway", `fs.exists` check. **"Remove anyway" is new product behaviour: confirm at the gate.**
8. *Correctness* (major) — mutations overwrote changes made during `openPane`; `Ref.modify` and one semaphore.
9. *Correctness / Information Hiding* (major) — plugins had no kernel UI to render; `@dia/renderer-plugin` re-exports `StatusIndicator` and shadcn primitives.
10. *Correctness vs settled decision* (major) — a tab lost its finished status behind the New agent form or the plugins page; `SelectTab { paneId: null }` while no tab is shown.
11. *Avoid Temporal Decomposition* (minor) — the `SelectTab` handler called two services in order; `AgentSummaries` folds `WorkspaceChanged`.
12. *Correctness* (minor) — removed panes kept their summaries and `visibleTab` was undefined after removal; drop absent panes, `removeProject` picks the next visible tab, `createTab` fails during removal.
13. *Correctness* (minor) — `revealPath` belongs in the preload with `ipcRenderer`, and main revealed any path; directory check.

**Rejected**
14. *Information Hiding* (minor) — `slot:<name>` shows in `PluginInfo.provides`. Rejected: that list is the plugins page's diagnostic of which plugin fills which slot, which is useful to show; plugin code still never depends on the key format, because it only calls `fillSlot`.

**Escalated** — none.

### Round 3

**Applied**
1. *Correctness* (blocker) — no view for "projects exist, no tab shown", and nothing showed the new tab after "Start agent"; `EmptyProjectView`, `addTab` sets `visibleTab`, `viewAtom` priority and clearing rule.
2. *Correctness* (major) — a cold worktree could not be removed with the worktrees plugin unloaded; `resolveGitOps`, `RemoveFailed` with a reason.
3. *Correctness* (major) — during removal, cold panes could be resumed and `visibleTab` pointed at a stopped pane; guards on `selectTab`/`ensureLive`, `visibleTab` moved first.
4. *Correctness* (major) — a dropped connection or Host restart mid-removal reported an error for a finished removal; "Check again", `ProjectNotFoundError` treated as complete.
5. *Correctness* (major) — no owner for `isGitRepo` and the directory check; `PaneWorkspace`, `.git` existence, migration keeps projects with missing directories.
6. *Command-Query Separation* (major) — mutations returned a `Workspace` and also broadcast it; mutations return `void`, `WorkspaceChanged` is the only source.
7. *Correctness* (major) — key listeners and drag sensors outlived an unloaded plugin; `acquireRelease` in the plugin scope.
8. *Correctness* (minor) — `inject` returns an `Effect`; corrected.
9. *Correctness* (minor) — `startRendererPlugins` does not store the registry; `main.tsx` stores it, `Slot` reads on first render then subscribes.
10. *Correctness* (minor) — the Host-restart outcome and who resumes the shown tab were unstated; renderer sends `SelectTab` at start and after `AgentSummariesReplaced`.
11. *Names* (minor) — `Uuid` and `PaneId` were mixed; `Uuid` everywhere, `PaneId` alias moves to `pane.ts`.

**Rejected** — none.

**Escalated** — none.

The round budget (medium, 3 rounds) is spent. Round 3's findings were applied without a fourth critique.
