# Pane chat projection

## Problem

A tab's chat state (`PaneChatState`) is built only in the renderer, by folding live pane events in
`paneChatAtom` (`src/renderer/src/lib/pane-chat-atoms.ts`). The atom is disposed 30 s after the tab
stops being shown, and a tab that was never shown has no atom. A rebuilt atom reads the transcript
(`getPaneHistory`), which holds one text part per turn. Everything else is lost: the running-turn
flag, streaming text, thinking and tool-call parts (and the task list built from `TodoWrite` calls),
background tasks, slash commands, the turn-status label, compaction failure, setup steps, and
attention (the Retry button reads a component-local listener in `Pane`).

## Decision

The Host owns each tab's `PaneChatState`. It folds every pane event it publishes into that state,
and serves a snapshot `{ state, seq }`, where `seq` is the pane's `EventHub` sequence number of the
last event folded in. The renderer subscribes to the pane's events, fetches the snapshot, and folds
only the events with a higher `seq`. This is the snapshot-then-tail scheme t3code uses
(`apps/server/src/ws.ts` `subscribeOrchestrationV2Thread`). `AgentSummary` stays the small
all-tabs record (t3code's all-threads summary record).

## Modules

### `src/shared/domain/json-record.ts` (new)

Exports `JsonRecord` (`Schema.Record(Schema.String, Schema.Unknown)`). `contract.ts:39` and
`attention.ts:4` import it instead of declaring their own copies.

### `src/shared/domain/pane-chat.ts` (moved from `src/renderer/src/lib/pane-chat.ts`)

- `TextPart`, `ThinkingPart`, `ToolCallPart`, `CompactionCounts`, `MessagePart`, `PaneMessage` and
  `PaneChatState` become Schemas; each type is `typeof X.Type`. Fields use `Schema.NullOr` and
  `Schema.optional`, never `Option` or `Result`, so values cross `contextBridge` intact.
  `ToolCallPart.input` is `Schema.optional(JsonRecord)`; `rewindable` is
  `Schema.optional(Schema.Literal(false))`; `setup` is `Schema.optional(Schema.Array(SetupStep))`.
- `PaneChatState` gains `attention: AttentionState` (`Idle` in `emptyPaneChatState`), replaced on
  every `PaneAttentionChanged`.
- `PaneChatSnapshot = Schema.Struct({ state: PaneChatState, seq: NonNegativeInt })`: the state
  after the pane's events numbered 1 to `seq`, on top of the transcript the tab was seeded from.
- `reducePaneChat(state, event, now?)` keeps its behaviour. Both former `Date.now()` sites
  (`appendSentMessages` `resumedAt` and `parkedMessage`) use `now`, and fall back to the wall clock
  when a caller passes none. The Host and the renderer atom always pass `now` from `Clock`.
- `PaneStreamEvent` and `PaneModelChangeNotice` (`PaneModelChanged` plus an optional
  `displayName`) stay plain types: they are reducer inputs that never cross a process boundary.
- `isPaneStreamEvent(event: IpcEvent): event is PaneStreamEvent` (JSDoc: "Whether `event` is one
  `reducePaneChat` folds.") tests `event._tag` against the
  reducer's tag set. The projection and the atom fold only the events it accepts, and advance `seq`
  for every frame.
- `paneChatStateFromHistory`, `lastUserText` and `isParkNotice` move unchanged.
- `formatResetTime` moves to `src/shared/format-reset-time.ts` with the
  `// @effect-diagnostics globalDate:off` header; `src/renderer/src/lib/format-when.ts` re-exports
  it, so its renderer callers do not change.

### `src/host/services/pane-chat-projection.ts` (new)

```ts
/**
 * The chat state of every workspace tab, folded from the Host's pane events on top of the tab's
 * transcript. Read a tab's state with `snapshot`. Call `seed` before starting a session that
 * resumes a transcript. Provide it with {@link PaneChatProjectionLive}.
 */
export class PaneChatProjection extends Context.Service<
  PaneChatProjection,
  {
    /**
     * The tab's chat state and the sequence number of the last event in it. A workspace tab with
     * no state yet is seeded from its transcript first; an id that is not a workspace tab gets
     * `emptyPaneChatState` and `seq` 0, and nothing is kept for it.
     */
    readonly snapshot: (paneId: PaneId) => Effect.Effect<PaneChatSnapshot>
    /**
     * Gives the pane state unless it already has some: a workspace tab with a session starts from
     * its transcript, any other pane (including one `createTab` is about to add) from the empty
     * state. Call it before a session for the pane starts, so the transcript it reads holds no turn
     * the session's events will also add.
     */
    readonly seed: (paneId: PaneId) => Effect.Effect<void>
  }
>()('PaneChatProjection') {}
```

Knowledge it owns: the current `PaneChatSnapshot` of every seeded workspace tab.

- `PaneChatProjectionLive` (JSDoc: "Live {@link PaneChatProjection}; follows the `EventHub` for
  the layer's lifetime.") requires `EventHub`, `WorkspaceFeed`, `TranscriptReader` and
  `ModelCatalogFeed`. It does not depend on `PaneWorkspace`, so `PaneWorkspace` can depend on it.
  In `buildHostLayer` (`host-main.ts`) `TranscriptReaderLive` (built inline today at `:148`) is
  hoisted to a named layer shared by `PaneWorkspaceLive` and the projection; the projection is
  added to `state` and provided to `PaneWorkspaceLive` and `DiaRpcHandlersLive`. `modelCatalog`
  and the projection are defined before `workspace` (`host-main.ts:143`, `:163`), and `workspace`
  takes the projection in its `Layer.mergeAll`. It is built before the Host posts
  `HostReady`, so no session runs yet.
- It follows `hub.subscribe({})` in one fiber forked with `forkScoped({ startImmediately: true })`
  (the `AgentSummaries` pattern), so it receives every frame published after the layer is built.
- **Entries.** An entry is `{ state, seq, inWorkspace }`. All reads and writes of the entry map go
  through one `Semaphore(1)`; state and `seq` are always written together. `seed` reads the
  transcript outside the semaphore, then inserts under it only if no entry exists (the first insert
  wins), so a slow read does not hold up folding for other panes.
- **Seeding.** `seed(paneId)` creates the entry when it has none: it reads the tab from
  `WorkspaceFeed`; a workspace tab with a `sessionId` starts from
  `paneChatStateFromHistory(paneId, transcriptReader.readHistory(sessionId, cwd))`, any other pane
  from `emptyPaneChatState`; `seq` starts at 0; `inWorkspace` is true when `WorkspaceFeed` holds
  the tab. Both session starts call it before
  anything can publish for the pane: `PaneWorkspace.startPaneSession` (resume, `selectTab`,
  `ensureLive`), before its cwd check and `emitErrored`, and
  `PaneWorkspace.createTab`, whose session starts before `addTab` puts the tab in the workspace
  (`pane-workspace.ts:611`, `:626`). So a transcript can only gain turns after its entry exists,
  and every event the session publishes is folded on top of it. The other restarts (thinking-level
  change, rewind fork, parked resume, Retry, `/clear`) run on a pane that already has an entry.
  `snapshot` calls `seed` for a workspace tab with no entry; no session runs for such a tab.
- **Folding.** For each `PaneEvent` frame of a pane with an entry, it folds the frame only when
  `frame.seq` is greater than the entry's `seq`: an event `isPaneStreamEvent` accepts goes through
  `reducePaneChat(state, event, now)` (`now` from `Clock`; `PaneModelChanged` gets `displayName`
  from `ModelCatalogFeed.current`), and any frame sets the entry's `seq` to `frame.seq`. A frame
  for a pane with no entry (a late event of a removed tab) is logged and ignored.
- **Eviction.** On each `WorkspaceChanged` frame it sets `inWorkspace` to true for entries whose
  pane is in the frame's workspace, then removes entries with `inWorkspace` true whose pane is not
  in it. No previous workspace is needed, so the first frame after startup evicts correctly; an
  entry `createTab` seeded for a tab not yet added (`inWorkspace` false) is kept.
- Logs seeding, eviction and ignored frames with Effect's logger.

### RPC and preload

- `DiaRpcs` gains `GetPaneChat { paneId } -> PaneChatSnapshot`, handled by
  `projection.snapshot(paneId)`. `GetPaneHistory` and `GetMessageQueue` are removed: their only
  caller is `paneChatAtom`. `PaneWorkspace.getPaneHistory`, used only by that RPC, is removed. `PROTOCOL_VERSION` becomes `'0.0.22'`.
- `DiaApi` gains `getPaneChat(paneId): Promise<PaneChatSnapshot>` and
  `onPaneEvent(listener: (frame: PaneEventFrame) => void): () => void`, fed from the preload's
  `handleFrame` for `PaneEvent` frames. `getPaneHistory` and `getMessageQueue` are removed, and the
  `DiaApi` JSDoc that mentions `getPaneHistory` (`contract.ts:987`) is updated.

### `paneChatAtom` (renderer)

1. Subscribe with `onPaneEvent`, keeping this pane's frames in a queue while no snapshot is held.
2. Fetch `getPaneChat(paneId)`; set the ref to `snapshot.state` and `floor` to `snapshot.seq`; fold
   the queued frames with `seq > floor`; fold each later frame with `seq > floor` and raise `floor`
   to it. Folding uses `reducePaneChat` with `now` from `Clock`, adding `displayName` to
   `PaneModelChanged` from the model list as today.
3. On `onHistoryReloadRequested(paneId)`: drop the held snapshot (frames queue again), then repeat
   step 2. A Host restart restarts `seq` at 1, and those frames wait in the queue until the new
   snapshot says which of them it already holds. A reload request received while a fetch is in
   flight discards that fetch's result and fetches again.

The 20 `window.dia.on*` subscriptions and the history, queue and field-preserving merges in
`loadHistory` are deleted. The 30 s idle TTL stays: a disposed atom rebuilds from the Host's
snapshot.

### `Pane` (chat plugin)

Reads `chat.attention` instead of its `['pane', paneId, 'attention']` query and listener, which are
deleted.

### `PaneWorkspace`

`startPaneSession` calls `projection.seed(paneId)` right after the tab is found and passes the
`archived` and `sessionId` guards, before the cwd check and any `emitErrored`. `createTab` calls it
before `supervisor.openPane`.

## Out of scope

- Turns from before the Host started still come from the text-only transcript, so their tool calls
  and task lists are not shown after a restart.
- Permission, question and plan cards keep reading `AgentSummary.status.request`; context usage
  keeps reading `AgentSummary.contextUsage`. The overview reads attention from `AgentSummary`; the
  chat view reads it from `PaneChatState`.
- After a dropped connection, the preload resumes only panes it holds a cursor for
  (`host-api.ts:141`); frames for a pane it never received one for are not replayed. This is
  unchanged by this design.

## Risks

- A parked notice already in a snapshot is formatted in the Host's locale; one folded in the
  renderer uses Chromium's.
- Part timestamps (`startedAt`, `endedAt`) in a snapshot are the Host's fold time.
- Host memory holds the chat state of every seeded workspace tab until the tab leaves the
  workspace. A `createTab` whose `openPane` or `addTab` fails leaves one empty entry (`inWorkspace` false)
  until the Host restarts.

## Tests

- `pane-chat.test.ts` moves with the reducer; its calls keep omitting `now`.
- `pane-chat-projection.test.ts`:
  - `snapshot` of a tab with a session seeds from its transcript with `seq` 0.
  - `seed`, then a `PaneUserMessagesSent` frame, gives one copy of the user message.
  - A frame with `seq` at or below the entry's is not folded twice.
  - `seq` is the last folded frame's.
  - An id that is not a workspace tab gets an empty snapshot and keeps no entry.
  - A tab removed from the workspace loses its entry; a seeded pane not yet in the workspace keeps
    its entry across a `WorkspaceChanged`.
  - A frame published after `seed` and before the tab is in the workspace reaches the snapshot.
  - A non-stream event advances `seq` without changing the state.
  - An entry seeded for a persisted tab is evicted when the first `WorkspaceChanged` removes that
    tab.
  - A model change notice uses the catalog's display name.
- `pane-chat-atoms.test.ts`:
  - Frames with `seq <= snapshot.seq` are skipped and later ones folded.
  - After a reload request with `floor` 500, frame 1 arriving before a snapshot with `seq` 0 is
    folded.
- `host-api.test.ts`: `onPaneEvent` receives `seq`.
- `pane-workspace.test.ts`: `createTab` and a resume call `seed` before `openPane`; an Errored
  frame emitted by `startPaneSession` for a missing cwd reaches the snapshot.

## ADR

New ADR "The Host keeps each tab's chat state and serves snapshots", amending ADR-0015 (the
renderer atom stays; its state is now seeded from a Host snapshot instead of the transcript). The
ADR names ADR-0030 too, since it already amends ADR-0015.

## Refinement record

Round 1:
- B1 seeding race: accepted with a different fix. Eager seeding of every tab at layer build was
  rejected (reads every transcript at startup); `PaneWorkspace.startPaneSession` calls `seed` before
  `openPane` instead (`pane-workspace.ts:795`, `selectTab` at `:830`, `createTab` at `:611`).
- B2 seed seq: accepted.
- B3 reload floor: accepted.
- M1 wiring, M2 snapshot mutates, M3 `PaneChatSnapshotJson`, M5 protocol version: accepted.
- M4: `JsonRecord`, both `Date.now()` sites, diagnostics header accepted. Making
  `PaneModelChangeNotice` a Schema rejected: it has no parallel schema and never crosses a boundary.
- m1-m5 accepted. m6 (a per-pane Host stream) rejected: it would duplicate the preload's
  reconnect and cursor logic in a second stream.
- Preload replay for panes without a cursor: recorded as out of scope; existing behaviour.

Round 2:
- F1 `createTab` starts a session before the tab is in the workspace: accepted. Fixed with the
  same `seed` call in `createTab` and eviction of departed tabs only, instead of the proposed
  `begin`/`discard` pair (one method covers both starts).
- F2 runtime predicate: accepted (`isPaneStreamEvent`).
- F3 hoist `TranscriptReaderLive`, `DiaRpcHandlersLive` name: accepted.
- F4 reload during a fetch: accepted. Queue cap rejected: frames queue only while a fetch is
  pending, and the preload's `query` retries the fetch.
- F5 remove `PaneWorkspace.getPaneHistory`: accepted.
- ADR names ADR-0030: accepted.

Round 3 (budget spent):
- F1 eviction needs a previous workspace that does not exist at startup: accepted (`inWorkspace`).
- F2 `emitErrored` publishes before `openPane`: accepted (`seed` before the cwd check).
- F3 `openPane` failure also leaves an entry: accepted.
- F4 `modelCatalog` defined after `workspace`: accepted.
- F5 transcript read under the lock: accepted; the read is outside the lock, which is safe because
  no session runs for the pane while `seed` reads.
- JSDoc text for `PaneChatProjectionLive` and `isPaneStreamEvent`, and literal wording for
  "shell": accepted.
- Recommended-rule note on `seed`'s call-order contract: not a violation; the call sites are named
  and tested.
