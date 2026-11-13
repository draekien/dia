# `dia-runs` plugin

Issue: draekien/dia#242, step 4 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0074.

`dia-runs` owns every agent session as a run: a row in its own database, a live session while it runs, its open requests as data, and its recovery after a reload or a Host start. It serves the UI-facing session calls with `requestId` deduplication, and exports the `AgentBackend` contract that `dia-claude-code` provides. A chat tab is a view of the run whose id is the tab's pane id.

It replaces `SessionFactory` and `PaneSupervisor` (`src/host/services/pane-supervisor.ts`), `tab-setup.ts`, `attached-sessions.ts`, the session RPCs of `DiaRpcs`, `src/host/session/agent-backend.ts`, `model-catalog-feed.ts`, `model-preferences.ts` and `adapter-status-feed.ts`.

## Success criteria

1. A tab chats, queues and steers, rewinds and parks (ADR-0041, ADR-0045) as before. (Test: the moved supervisor tests in `plugins/dia-runs/run-registry.test.ts`; app: one turn, a queued and a steered message, a rewind.)
2. A run with no tab runs to completion, survives a restart, and opens in a tab. (Test: `Runs.start` without a tab reaches `idle`, its row survives a new registry over the same database, `openInTab` emits `TabRequested`; app: `StartRun` from DevTools, restart, `OpenRunInTab` shows its history.)
3. A `SendMessage` resent after a reconnect sends one message. (Test: two `SendMessage` handler calls with the same call id send one message, also when the second arrives after a reload.)
4. Reloading `dia-runs` mid-turn resumes that turn and does not start a turn in an idle run. (Test: a registry over a database whose rows say `running` and `idle` sends `continue` only to the first.)
5. `plugin_reload` of `dia-runs` from inside a run completes and is not repeated. (Test: `makePluginTools` defers an operation on the calling plugin until `turnEnded`, and the deferred reload runs after the calling fiber is interrupted; the turn then ends `idle`, so recovery does not resume it.)
6. No file in `src/` imports `AgentBackend`. (Test: `plugins/dia-runs/boundary.test.ts` greps `src/`.)

## Decisions taken without the user

D1. **The kernel reaches `dia-runs` through a kernel seam key, `RunsKey`, declared in `src/host/services/runs-seam.ts` and re-exported from `@dia/plugin`.** The kernel still owns tabs (`PaneWorkspace`) and must open, close and configure a tab's run; it cannot import a plugin. `RunEventsKey` stays a kernel seam for the same reason (`EventHub` reads it). Later steps (inbox, queue, messaging, schedules, checkpoints, terminals, cost) read `RunsKey` from `@dia/plugin` with `ctx.whenProvided`. Alternative: declare the contract in `dia-runs`' exported module and move tabs into a plugin, which is not in this step's scope.

D2. **A run id is a string; a tab's run id is its pane id.** Rows are created on a run's first open, so existing tabs need no migration. Alternative: a copy step creating one row per tab; it adds a handover for no observable gain.

D3. **`dia-runs` provisions a run's worktree** (the moved `tab-setup.ts` and the worktree code of `openPane`), reading `WorktreesKey` with `ctx.whenProvided`. It can then reopen any run by itself: a `SendMessage` to a cold run and recovery after a Host start, when the worktree was released at quit. Alternative: the kernel keeps worktrees and `dia-runs` calls back into the kernel, which needs a new plugin-context member and a callback cycle.

D4. **Tab settings stay kernel calls.** `SetThinkingLevel`, `SetPermissionMode` and `SetModel` stay in `DiaRpcs`, because the tab's stored config is the workspace's; the kernel stores it and calls `Runs.setThinkingLevel` (etc.). The other session calls (`SendMessage`, `EditQueuedMessage`, `RemoveQueuedMessage`, `SendQueuedMessageNow`, `ResolvePermission`, `ResolveQuestion`, `ResolvePlanReview`, `InterruptRun`, `ResumeParkedRun`, `RewindToCheckpoint`) leave `DiaRpcs` for `dia-runs`. Alternative: move them too, which needs the workspace to follow config changes from `dia-runs`.

D5. **The renderer is unchanged; the preload routes.** `window.dia.sendMessage` and the other session, model and adapter methods keep their signatures; the preload sends them as `CallPlugin` / `SubscribePlugin` to `dia-runs`, with the command id as the call id. Alternative: `dia-chat` calls `callHost('dia-runs', …)` itself, which rewrites every chat call site for the same wire result.

D6. **Deduplication uses an `applied_calls` table in `dia-runs`' database**, not the run's events: a call id is inserted before the call is applied, and a call whose id is present applies nothing and succeeds. Every session call returns `void`, so "the first result" is `void`. Alternative: an event type in `dia-run-events`, which couples the two plugins' schemas for no reader.

D7. **Requests are held in memory**, as `Runs.requests`. A request is a `canUseTool` callback of a live session, which does not survive the session, so a stored request could not be answered after a restart.

D8. **Recovery rule.** A run's row stores `status`: `idle`, `running` (a turn is in progress), `waiting` (a request is open) or `archived`. `UserMessagesSent` and an answered request set `running`; a request sets `waiting`; `TurnCompleted`, `TurnErrored`, `TurnParked`, an interrupt and a session end set `idle`. Closing a run's scope (reload, quit) writes nothing. When `dia-runs` starts it opens each `running` row with its session id and sends `continue` (`AgentSession.resume`); a `running` row without a session id becomes `idle` and its tab shows `Errored` with "The turn was interrupted before it started. Send your message again." (the composer is the Resume action). `waiting` and `idle` rows are not opened.

D9. **`plugin_*` tools come from the plugin context, and an operation on the plugin that runs the session waits for the turn to end.** `HostPluginContext.sessions` is replaced by `pluginTools(turnEnded)`, which returns the three kernel tools for one session. Each tool runs its operation in a detached kernel fiber; when the target is the calling plugin (`dia-runs`), the fiber first awaits `turnEnded` and the tool returns at once with "dia-runs reloads when this turn ends". The turn then ends `idle`, so recovery does not repeat it. `PLUGIN_API_VERSION` goes to 0.0.39.

D10. **`ctx.sessions.attach` and attached sessions are removed** (no shipped plugin calls them since org was archived), with `GetAttachedSessions`, `ResetAttachedSession`, `AttachedSessionsChanged` and the renderer's attached view. A run with no tab is shown by opening it in a tab (`OpenRunInTab`); listing such runs is the inbox's (step 5).

D11. **The usage-limit resume setting and the model preferences move to `dia-runs`** (its `settings` table), with `GetUsageLimitResume`, `SetUsageLimitResume` and the preference calls of D13. At its first start `dia-runs` copies `usageLimitResume` and `adapters` once from the kernel's `settings.json`, read at `hostSettingsOf(ctx.dataDir)` (a kernel function beside `hostDatabaseOf`, same precedent: run-events D3); the kernel's copy is left in place and no longer read.

D12. **`agent-summaries.ts` stays in the kernel** (deferred again from step 3, D4 there). It folds pane frames from the hub, which `dia-runs` still produces through `dia-run-events`; moving it needs a renderer change unrelated to runs. MCP servers and the `dia` server (ADR-0075) are passed to `openSession` in step 6, when the tool registry exists; the adapter keeps reading its own registries until then.

D13. **Model and adapter feeds move into `dia-runs`** as calls: `GetModels`, `RefreshModels`, `FollowModels`, `GetAdapterStatus`, `CheckAdapterHealth`, `SetInstallPath`, `FollowAdapterStatus`, `GetModelPreferences`, `SetModelPreference`, `SetAgentDefaults`, `FollowModelPreferences`, `GetDisabledPermissionModes`, `GetAttachmentTypes`.

## Interface

### Kernel seam (`src/host/services/runs-seam.ts`, re-exported from `@dia/plugin`)

```ts
/** How a run's worktree is obtained: a new one labelled `label`, or the run's existing one re-added. */
export type WorktreeRequest = { _tag: 'Create'; label: string } | { _tag: 'Reattach'; info: WorktreeInfo }

/** What a run opens with. `resume` names the conversation it continues. */
export interface RunSpec {
  readonly runId: string
  readonly sourceCwd: string
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly permissionMode: PermissionMode
  readonly worktree: WorktreeRequest | undefined
  readonly resume: Option<SessionId>
}

/** An answer to one open request of a run. */
export type RunAnswer = PermissionAnswer | QuestionAnswer | PlanReviewAnswer  // tagged schemas

/** An open request of a run: `request` is the attention request the session raised. */
export interface RunRequest { readonly runId: string; readonly request: AttentionRequest }

/** A change the tab owner follows: the run's session or permission mode changed, or a tab was asked for. */
export type RunChange = RunSessionChanged | RunPermissionModeChanged | RunTabRequested

export interface Runs {
  /** Opens run `spec.runId` (provisioning its worktree) unless it is live; returns its config. */
  readonly open: (spec: RunSpec) => Effect<PaneConfig, WorktreeCreateError | WorktreeReattachError>
  /** Starts a run with no tab in `cwd` and sends `text`; returns its id. */
  readonly start: (options: StartRunOptions) => Effect<string>
  readonly send: (runId, text, mode, attachments?) => Effect<void>
  readonly editQueued / removeQueued / sendQueuedNow
  readonly answer: (runId: string, requestId: string, answer: RunAnswer) => Effect<void>
  /** Every open request of every run, now and after each change. */
  readonly requests: Stream<ReadonlyArray<RunRequest>>
  readonly interrupt / resumeParked / rewind
  readonly setThinkingLevel / setPermissionMode / setModel
  /** Completes when run `runId` has no turn in progress. */
  readonly awaitIdle: (runId: string) => Effect<void>
  readonly isLive: (runId: string) => Effect<boolean>
  /** Ends the run's session and releases its worktree; the row stays. */
  readonly close: (runId: string) => Effect<void>
  /** Closes the run and marks it archived, or deletes its row. */
  readonly retire: (runId: string, as: 'archived' | 'deleted') => Effect<void>
  readonly list: Effect<ReadonlyArray<RunInfo>>
  /** Asks the tab owner to show run `runId` in a tab. */
  readonly openInTab: (runId: string) => Effect<void, RunNotFoundError>
  readonly changes: Stream<RunChange>
  readonly discoverSessions: (directory: string) => Effect<ReadonlyArray<DiscoveredSession>>
}
export const RunsKey: ServiceKey<Runs>
```

Every method is safe to call for an unknown run: it logs and does nothing (`open` and `openInTab` excepted). The kernel service `RunsClient` (`src/host/services/runs-client.ts`) reads `registry.inject(RunsKey)` on each call (the `RunEventLog` precedent) and `changes` switches to each new provider's stream. With no provider, `open` fails `RunsNotLoadedError`, and every other method logs and does nothing.

### Plugin (`plugins/dia-runs`)

- `plugin.json`: `name: dia-runs`, `category: feature`, `host: host.ts`, `load: eager`, `exports: ["backend.ts", "calls.ts"]`.
- `backend.ts` (exported): `AgentBackend`, `AgentSession`, `AgentSessionOptions`, `SessionEnd`, `SessionFailed`, `SessionNotFound`, `TranscriptEntry`/`Info`/`Tail`, `AgentBackendKey`, `agentBackendProblems`, `unavailableBackend`, moved from `src/host/session/agent-backend.ts`. `SessionAdditions` moves to `meta-repo-seam.ts`, `DiscoveredSession` to `runs-seam.ts`. `dia-claude-code` and `dia-run-events` import `AgentBackendKey` from `@dia-plugin/dia-runs/backend`.
- `calls.ts` (exported): the session calls of D4 with payload `{ runId, … }`, `StartRun`, `OpenRunInTab`, `GetUsageLimitResume`, `SetUsageLimitResume`, and the model/adapter calls of D13.
- `run-registry.ts`: the live runs (moved `startPane`, attention, parking, session end), the `runs` table, status writes, requests, recovery, worktree setup (moved `tab-setup.ts`).
- `feeds.ts`: models, adapter status and preferences over the followed backend.
- `host.ts`: opens the database, follows `AgentBackendKey`, `RunEventsKey`, `WorktreesKey` and `MetaRepoKey` with `ctx.whenProvided` into refs, builds the registry, runs recovery after providing `RunsKey`, and serves the calls, deduplicating session calls through `applied_calls`.

Events a run produces are appended to its log with `RunEvents.append` (retried as `EventHub` does) or recorded with `RunEvents.record`; the hub delivers them to the renderer as before.

### Database (`<userData>/plugins/dia-runs/data.db`)

`1_create_runs`: `runs` (`run_id` PK, `spec_json`, `session_id`, `status` CHECK in `idle|running|waiting|archived`, `has_tab`, `created_at`), `applied_calls` (`request_id` PK, `run_id`, `tag`, `applied_at`), `settings` (`key` PK, `value_json`).

## Kernel changes

- `PaneWorkspace` uses `RunsClient` instead of `PaneSupervisor`, follows `changes` to record session ids and permission modes, and imports a tab on `RunTabRequested`; `importableSessions` calls `Runs.discoverSessions`.
- `DiaRpcs` loses the session calls of D4, the model/adapter calls of D13, the usage-limit calls, `GetAttachedSessions` and `ResetAttachedSession`; `IpcEvent` loses `ModelsChanged`, `AdapterStatusChanged`, `ModelPreferencesChanged` and `AttachedSessionsChanged`. `PROTOCOL_VERSION` goes to 0.0.30.
- Host shutdown no longer calls `closeAll`; closing the registry closes `dia-runs`, whose finalizers end sessions and release worktrees without writing statuses.

## Refinement Record

Round 1 (inline):

**Applied**
- *Correctness, major* — "Closing a run's scope writes nothing" was missing; without it a quit wrote `idle` from the session-end path and recovery never resumed. Added to D8 and the shutdown note.
- *Correctness, major* — the kernel's `selectTab` and recovery can open one run twice at Host start. `open` is serialised per run and returns the live run's config.
- *Strategic Programming, minor* — `retire` took a boolean; it now takes `'archived' | 'deleted'`.

**Rejected**
- *Information Hiding, major, `RunSpec.worktree` exposes worktree mechanics to callers* — the tab owner chooses between a new and an existing worktree; that is the caller's knowledge, not the run's.
- *Avoid Temporal Decomposition, minor, split recovery into its own module* — recovery reads and writes the same rows and live runs the registry owns.
