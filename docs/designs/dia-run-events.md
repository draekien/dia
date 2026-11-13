# `dia-run-events` plugin

Issue: draekien/dia#241, step 3 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0074.

`dia-run-events` owns every run's event log, its item projection and its chat snapshots in the plugin's own database, and reads a run's Claude Code transcript to catch up turns added outside dia. It replaces `agent-event-store.ts`, `agent-event-recorder.ts`, `pane-chat-projection.ts` and `transcript-reader.ts` in `src/host/services/`. `agent-summaries.ts` moves with step 4 (D4).

## Success criteria

1. A conversation stored in `host.db` before the upgrade shows the same history after the plugin's first start. (Test: `plugins/dia-run-events/handover.test.ts` copies a `host.db` file built with `kernelMigrations`; `readHistory` then returns the same items and `readAfter(0)` the same events with the same sequences, and the first event appended afterwards gets the copied maximum plus one or more. App: a scratch profile whose `host.db` holds conversations; each tab shows its history.)
2. Starting the plugin a second and a third time copies nothing. (Test: same file; rows added to `host.db` after the first start are not copied, and counts are unchanged. App: started twice, the log line `Copied the event log from host.db` appears in the first run only.)
3. Removing a tab deletes none of its events. (Test: `plugins/dia-run-events/projection.test.ts` removes the tab from the workspace stream and the store still returns its history. The plugin database has no trigger and the plugin prunes nothing. App: remove a tab, restart, its rows are still in `data.db`.)
4. A renderer plugin follows a run's chat: `followHost('dia-run-events', FollowRunChat, { runId })` yields the run's snapshot first, then each event of that run committed after it, with its sequence. (Test: `plugins/dia-run-events/host.test.ts`.)
5. The kernel's tabs keep working: chat, archive, attach and resume read and write through the plugin. (Existing kernel tests with the seam faked; app check of one turn.)

## Run id until `dia-runs`

A run id is a string. Until `dia-runs` (#242) creates runs, the run id of a tab or an attached session is its pane id. The copy keeps each `agent_id` as the `run_id`, so #242 creates one run per existing tab with the tab's pane id as the run id, and its events are already keyed (D2).

## Interface

### Kernel seam (`src/host/services/run-events-seam.ts`)

The kernel still runs tab sessions until #242, so it reaches the plugin through a key it declares (D1).

```ts
/** What `dia-run-events` provides under {@link RunEventsKey}. */
export interface RunEvents {
  /**
   * Appends events to run `runId`'s log in one transaction and updates its items. Returns
   * `Some(sequence)` per appended event and `None` per skipped duplicate (same source uuid and item).
   * Appending `AgentArchived` deletes the run's superseded streaming events.
   */
  readonly append: (runId: string, events: ReadonlyArray<AppendEntry>) =>
    Effect<ReadonlyArray<Option<number>>, RunEventWriteError>
  /** Every event committed from now on, by any run, in sequence order. */
  readonly committed: Stream<CommittedEvent>
  /** Events of `runId` after `afterSequence`, or why they cannot be replayed. Never fails. */
  readonly readAfter: (runId: string, afterSequence: number, limits: ReplayLimits) =>
    Effect<Replay | ReloadRequired>
  /** The highest sequence of any run, 0 when none. */
  readonly highestSequence: Effect<number, RunEventReadError>
  /** The highest sequence when this provider started, before it accepted any append. */
  readonly startSequence: number
  /** Starts recording one session of run `options.runId`; the recording lives in the caller's scope. */
  readonly record: (options: RecordingOptions) =>
    Effect<(message: OutboundMessage) => Effect<void>, never, Scope>
  /** The run's chat state and the sequence it is current to; seeds a workspace tab first. */
  readonly snapshot: (runId: string) => Effect<PaneChatSnapshot>
  /** Builds the run's chat state from its stored log (after a transcript catch-up) unless it has one. */
  readonly seed: (runId: string) => Effect<void>
  /** Drops the in-memory chat state of a run that is not a workspace tab. Deletes no event. */
  readonly release: (runId: string) => Effect<void>
}

/**
 * The key `dia-run-events` provides {@link RunEvents} under, named `runEvents`. A value counts as
 * provided when `append`, `readAfter`, `record`, `snapshot`, `seed` and `release` are functions and
 * `committed` is a stream, `highestSequence` an effect and `startSequence` a number.
 */
export const RunEventsKey: ServiceKey<RunEvents>

/** Kernel service: {@link RunEvents} delegating to the value the loaded plugin provides now. */
export class RunEventLog extends Context.Service<RunEventLog, RunEvents & {
  /** The first provider's `startSequence`; fixed for the Host's lifetime. Waits for a provider. */
  readonly hostStartSequence: Effect<number>
}>
/** Holds the registry `RunEventLog` reads, completed once `HostPlugins` is built. */
export class RunEventLogRegistry extends Context.Service<RunEventLogRegistry,
  Deferred<Pick<PluginRegistry, 'inject' | 'changes'>>>
export const RunEventLogRegistryLive: Layer<RunEventLogRegistry>
export const RunEventLogLive: Layer<RunEventLog, never, RunEventLogRegistry>
/** Completes RunEventLogRegistry from HostPlugins. */
export const RunEventLogConnectLive: Layer<never, never, RunEventLogRegistry | HostPlugins>
```

`RunEventLog` awaits the registry, then reads `registry.inject(RunEventsKey)` on each call (with a `biome-ignore` reason, as `resolveAgentBackend` does: a `use` lease would hold the plugin open for a session's lifetime). `committed` follows `registry.changes` filtered to `runEvents` and switches to the new provider's stream (the `agentBackendChanges` shape). `hostStartSequence` is the `startSequence` of the first provider seen, which the plugin reads after the handover and before it provides, so no append can precede it; later reloads do not change it. The hub awaits it only after `readAfter` returned a `Replay`, which implies a provider.

When nothing is provided: `append` fails with `RunEventWriteError`, `readAfter` returns `ReloadRequired('readFailed')`, `highestSequence` returns 0, `record` logs an error and returns a recorder that records nothing, `snapshot` returns the empty state at sequence 0, `seed` and `release` do nothing. An empty chat for a failed plugin is intended: the Plugins page shows the failure; a tab opened or refreshed after the plugin loads shows the history, and open tabs keep the empty state until then.

Schemas and types `StoredEvent`, `AppendEntry`, `CommittedEvent`, `Replay`, `ReloadRequired`, `ReplayLimits`, `RunEventWriteError`, `RunEventReadError`, `RecordingOptions` and `TranscriptCursor` move to the seam, with `agentId` renamed `runId`.

#242 deletes `RunEventLog`, `RunEventLogRegistry` and the layers, and moves `RunEvents`, `RunEventsKey` and the schemas into `dia-run-events`' exported module.

### Exports added to `@dia/plugin` (`src/host/plugin-api.ts`)

The seam values above (except the kernel service and layers), `hostDatabaseOf(dataDir)` from `src/host/plugins/plugin-paths.ts` (beside `pluginDataDir`, which `host-plugins.ts` uses to build `dataDir`; it stays until the handover is removed), `PaneChat` (namespace of `src/shared/domain/pane-chat.ts`: `PaneChatSnapshot`, `paneChatStateFromItems`, `reducePaneChat`, `isPaneStreamEvent`, `emptyPaneChatState`), and `PaneAgentEvent`. `AgentItem` and `ConversationMessage` are already reachable through `AgentEvents`. The plugin context is unchanged, so `PLUGIN_API_VERSION` stays (its rule counts changes to the plugin context).

### Plugin (`plugins/dia-run-events`)

- `plugin.json`: `name: dia-run-events`, `api: 0.0.38`, `category: feature`, `host: host.ts`, `load: eager`, `exports: ["calls.ts"]`.
- `host.ts`: opens `ctx.database(runEventsMigrations)`, runs the handover, keeps the latest `ctx.workspace` value in a `Ref` (awaiting the first before providing), reads the agent backend with `ctx.whenProvided([AgentBackendKey], …)` into a `Ref` cleared when it is withdrawn, builds the store, recorder and projection, provides `RunEventsKey`, and serves `FollowRunChat`. A catch-up with no backend reads nothing; the model display name of `PaneModelChanged` comes from the backend's `models()` stream.
- The store does not write `agents.archived_at` (`WorkspaceStore` owns it, `workspace-store.ts:315`) and does not port `pruneOrphans`.
- The projection folds the store's own `committed` stream (D5).
- `calls.ts` (exported):

```ts
export const RunChatSnapshot = Schema.TaggedStruct('RunChatSnapshot', { snapshot: PaneChatSnapshot })
export const RunEventCommitted = Schema.TaggedStruct('RunEventCommitted', { sequence: Schema.Int, event: StoredEvent })
export const RunChatUpdate = Schema.Union([RunChatSnapshot, RunEventCommitted])
/**
 * Follows run `runId`'s chat: its snapshot first, then each event of `runId` committed after the
 * snapshot, in sequence order. Fold the events with `PaneChat.reducePaneChat`.
 */
export const FollowRunChat = Rpc.make('FollowRunChat', {
  payload: { runId: Schema.String }, success: RunChatUpdate, stream: true
})
```

The handler subscribes to `committed` first, then takes the snapshot, then emits only events of `runId` with `sequence > snapshot.seq`.

### Database (`<userData>/plugins/dia-run-events/data.db`)

`1_create_run_events`: `run_events` (`sequence` AUTOINCREMENT, `run_id`, `event_type`, `item_id`, `source_uuid`, `occurred_at`, `payload_json`), `run_items` (`run_id`, `item_id`, `position`, `kind`, `streaming`, `payload_json`), `transcript_cursors` (`session_id`, `last_uuid`, `file_size`, `mtime_ms`), and `handover` (`id = 1`, `copied_at`). The indexes of the `host.db` tables, keyed by `run_id`. No trigger deletes events.

### Handover

At each start, before providing the service: when `handover` has no row, `ATTACH` `hostDatabaseOf(ctx.dataDir)` as `host`, and in one transaction copy `agent_events` (keeping `sequence`), `agent_items` and `agent_transcript_cursors` with plain `INSERT … SELECT`, then insert the `handover` row; `DETACH` runs in `Effect.ensuring`. The attached database is only read. A missing `host.db` file or missing tables copy nothing and still insert the row. A failed copy fails the plugin's setup, so the plugin records nothing until a later start copies; this keeps copied sequences from colliding with new ones. `ATTACH` runs outside the transaction because SQLite refuses it inside one; `SqliteClient` uses one connection, so the attach is visible to the transaction.

## Kernel changes

- `EventHub` reads `RunEventLog` instead of `AgentEventStore`, and `hostStartSequence` from `RunEventLog.hostStartSequence`.
- `PaneSupervisor` calls `RunEventLog.record`; `PaneWorkspace` and `AttachedSessions` call `RunEventLog.seed`, `release` and `append`; `GetPaneChat` calls `RunEventLog.snapshot`.
- `PaneWorkspace.discoverSessions` reads `resolveAgentBackend` directly; `TranscriptReader` is deleted.
- `host.db`'s `agent_events`, `agent_items` and `agent_transcript_cursors` stay; the kernel no longer reads or writes them except through the existing `agents_delete_events` trigger (D7).
- `DiaRpcs` is unchanged, so `PROTOCOL_VERSION` stays.
- Plan row 3 and ADR-0074's More Information note that `agent-summaries.ts` moves with step 4.

## Decisions taken without the user

D1. **The kernel reaches the plugin through a seam key until #242.** Alternatives: move the session path into the plugin now (#242's scope); keep the store in the kernel (contradicts ADR-0074). Chosen: seam, the `AgentBackendKey` precedent, with a `Deferred` registry holder to break the `EventHub` ← `HostPlugins` cycle (the `SessionAttacher` precedent).

D2. **A tab's run id is its pane id.** Alternative: mint run ids now and map tabs to them, which needs a run table, which is `dia-runs`' data.

D3. **The copy runs outside the migrations, guarded by a `handover` row.** Pending migrations share one transaction and SQLite refuses `ATTACH` in a transaction. Alternatives: the kernel pushes rows to the plugin (kernel code for a plugin's concern); a new `ctx` field naming `host.db` (permanent plugin API for a one-time copy). Chosen: the plugin attaches the path `hostDatabaseOf(ctx.dataDir)`, a kernel function in `plugin-paths.ts` beside `pluginDataDir`.

D4. **`agent-summaries.ts` stays in the kernel until step 4.** It folds live session status and activity lines into `activity.json`, not the event log, and publishes through the kernel hub; it is run status, which `dia-runs` owns. Moving it now needs a plugin-to-hub publish path or a renderer change, both rewritten again in #242. This amends ADR-0074's list and plan row 3.

D5. **The chat projection folds the store's `committed` stream**, not `ctx.events`, so it does not depend on the kernel hub's ordering.

D6. **A reload of `dia-run-events` during a running session stops that session's recording** (its writes fail and are logged) until the session restarts. ADR-0074 states such a reload interrupts turns; `dia-runs` restarts runs in #242. Alternative: a lease per session, which blocks reloads.

D7. **Legacy tables stay in `host.db`.** Dropping them needs the kernel to know the copy finished; a later step drops them. Until then `agents_delete_events` still deletes a removed tab's legacy rows, so a handover retried after a failure lacks tabs removed meanwhile.

## Refinement Record

Round 1:

**Applied**
- *Correctness, B1* — the store wrote `agents.archived_at` and pruned via `agents`; the plugin drops both.
- *Correctness, B2* — `hostStartSequence` is now read once from the first provider and fixed.
- *Correctness, M1* — wiring is a `Deferred` registry holder with per-call `inject` and a switching `committed`.
- *Correctness, M2* — listed the `@dia/plugin` exports and the `api` field.
- *Correctness, M3* — plain `INSERT`, `DETACH` in `ensuring`, the sequence test, the trigger note in D7.
- *Correctness, M4* — `FollowRunChat` subscribes before the snapshot.
- *m1* — workspace held in a `Ref`; display names from `models()`.
- *Project rules, M5* — D4 now amends plan row 3 and ADR-0074's More Information.
- *Information Hiding, M6* — path from a kernel function `hostDatabaseOf`, not a literal `../..` in the plugin.
- *m2, m3, m4, m6* — comments moved to JSDoc, run-id rule stated once, `is` stated, #242 deletions listed.
- *m5* — empty fallback stated as intended.

**Rejected**
- *M2, `PLUGIN_API_VERSION` bump* — `manifest.ts:18-22` ties the version to the plugin context, which this step does not change; added exports do not refuse older plugins.
- *M6, a `ctx` field* — permanent API for a one-time copy; `hostDatabaseOf` keeps the layout knowledge in the kernel.

Round 2:

**Applied**
- *Correctness, major* — `hostStartSequence` could include this Host's own events; it is now the provider's `startSequence`, read before the provider accepts appends.
- *Strategic Programming, major* — `hostDatabaseOf` moved to `src/host/plugins/plugin-paths.ts`, outside the seam #242 deletes.
- *minor* — the empty-fallback wording no longer claims a re-fetch.

**Rejected**
- *minor, split `hostStartSequence` out of `RunEventLog`* — the hub is its only reader and already depends on `RunEventLog`; a second tag adds wiring for one value.

Round 3 (inline): checked the round-2 changes against `event-hub.ts:116` and `host-plugins.ts:84`; no blocker or major finding. Rounds stopped.
