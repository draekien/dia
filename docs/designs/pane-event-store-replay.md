# Pane events from the agent event store

Implements #156 under a new ADR-0052. ADR-0052 amends ADR-0051's "Replay to the renderer" section its sentence "History reads page `agent_items` by `(agent_id, position)` and never replay `agent_events`", its Consequences bullet "opening an agent reads one page from `agent_items` by index" (now: all of the agent's items in one transaction), adds a Content-table row "Stored: every pane `IpcEvent` other than `PaneAgentEvent`", amends ADR-0022 (replay buffer) and ADR-0050 (seed source). Each amended ADR gets an "Amended by ADR-0052" line; `docs/adr/README.md` gets the index entry.

## Problem

`EventHub` (`src/host/services/event-hub.ts`) numbers pane events per Host run and keeps the last 1000 per pane in memory; a Host restart clears both. History is seeded once per Host run from `TranscriptReader.readHistory`, which parses the whole JSONL and drops tool calls. `agent_events` already holds each agent's conversation (#160, #162, #164), but the renderer never reads it.

## Rule

Every pane event the Host sends is one `agent_events` row, and its frame's `seq` is that row's `sequence`. Every `agent_events` row that decodes is sent as one pane frame, in `sequence` order; rows that archive deleted are not sent. History is `agent_items`; replay is `agent_events`.

## Wire changes (`src/shared/ipc/contract.ts`, `src/shared/ipc/rpc.ts`)

| Before | After |
| --- | --- |
| `PaneAssistantTextDelta`, `PaneAssistantThinkingDelta`, `PaneToolCallStarted`, `PaneToolCallCompleted`, `PaneMessageAppended`, `PaneCheckpointAvailable` | Removed. Replaced by `PaneAgentEvent = Schema.TaggedStruct('PaneAgentEvent', { paneId, agentEvent: AgentEvent })` |
| `PaneEventFrame.seq`: per-Host-run counter starting at 1 | `agent_events.sequence`; increases, not contiguous (doc comment at `rpc.ts:91-93` reworded) |
| `PROTOCOL_VERSION = '0.0.22'` | `'0.0.23'` |

`contract.ts` also exports `PaneSignal = Schema.Union([PaneToolCallUpdated, PaneTurnStatusChanged, PaneSessionNotice, PaneSetupProgress, PaneBackgroundTasksChanged, PanePermissionRequested, PaneQuestionRequested, PanePlanReviewRequested, PaneSlashCommandsWarming, PaneSlashCommandsAvailable, PaneConversationCompacted, PaneConversationReset, PaneRewoundToCheckpoint, PaneRewindFailed, PaneMessageQueueChanged, PaneUserMessagesSent, PaneModelChanged, PaneContextUsageChanged, PaneCompactionFailed, PaneAttentionChanged, PaneCreateFailed])`: the pane events that stay on the wire unchanged. Every `IpcEvent` member with a `paneId` is `PaneAgentEvent` or a `PaneSignal` member; a test asserts this. Doc comments naming `PaneCheckpointAvailable` are reworded.

Example: one assistant reply streamed over 120 ms.

```
before (per token)                         after (one row per 50 ms flush)
seq 41 PaneAssistantTextDelta "Hel"        seq 9120 PaneAgentEvent MessageUpdated{itemId:"a1", "Hel",          streaming:true}
seq 42 PaneAssistantTextDelta "lo, "       seq 9124 PaneAgentEvent MessageUpdated{itemId:"a1", "Hello, wor",   streaming:true}
seq 43 PaneAssistantTextDelta "wor"        seq 9131 PaneAgentEvent MessageUpdated{itemId:"a1", "Hello, world", streaming:false}
seq 44 PaneAssistantTextDelta "ld"
seq 45 PaneMessageAppended "Hello, world"
```

## Modules

### `agent-event.ts` (`src/shared/domain/agent-event.ts`)

Two new `AgentEvent` members, so that `agent_items` matches what the renderer shows after `/clear` and rewind:

* `ConversationCleared {}` — the projection deletes the agent's items.
* `ConversationRewound { checkpointUuid }` — the projection deletes the agent's items at and after the user message item whose `checkpointUuid` it is; a rewind to an unknown uuid changes nothing.

### `AgentEventStore` (`src/host/services/agent-event-store.ts`) — owns rows and their commit order

Knowledge it owns: what is committed for each agent, in commit order.

* `StoredEvent = Schema.Union([AgentEvent, PaneSignal])`. `append(agentId, entries)` accepts `StoredEvent`s. A `PaneSignal` row has `event_type` = its `_tag`, no `item_id`, no `source_uuid`, and no projection. Only `AgentEvent`s change `agent_items`.
* `CommittedEvent = Schema.Struct({ agentId, sequence, event: StoredEvent })`. New `committed: Stream<CommittedEvent>`: every row a transaction inserts (`append`, `appendTranscript`) is offered after its commit. Each write — the transaction and its offer — runs under one 1-permit semaphore, so offer order equals commit order. `appendTranscript` takes the permit per 500-entry batch. Rows of a rolled-back transaction are never offered. `committed` is backed by an unbounded `PubSub`, so the offer never blocks while the permit is held. Lock order: recorder semaphore, then store semaphore. Reads take no semaphore.
* New `readAfter(agentId, afterSequence, limits: { maxEvents, maxBytes }): Effect<Replay | ReloadRequired>` (both `Schema.TaggedStruct`, built with `.make`). One read transaction runs: `MAX(sequence)` for the agent as `through` (0 when none); `COUNT(*)` of rows in `(afterSequence, through]`; when it is at most `maxEvents`, `SUM(LENGTH(CAST(payload_json AS BLOB)))` over those rows; then the rows. Returns `Replay{ events, through }`, or `ReloadRequired{ reason }` where `reason` is `ahead` (`afterSequence > through`), `tooLarge` (more than `maxEvents` rows, or more than `maxBytes` bytes; both checked before any row is read, the byte sum only over at most `maxEvents` rows), `undecodable` (a row in range does not decode), or `readFailed` (the read failed; logged at error).
* New `readHistory(agentId): Effect<{ items, through }, AgentEventReadError>`: all of the agent's items in position order and `MAX(sequence)` (0 when none), in one read transaction.
* New `lastSequence(agentId): Effect<number, AgentEventReadError>`.
* New `highestSequence: Effect<number, AgentEventReadError>`: the highest `agent_events.sequence` of any agent, 0 when there is none.
* At layer build, deletes `agent_events` and `agent_items` rows whose `agent_id` has no `agents` row (left by a `createTab` that failed after the pane emitted events), and logs the count.
* `readItems` is removed; `readHistory` replaces it.

### `EventHub` (`src/host/services/event-hub.ts`) — owns client delivery

Knowledge it owns: which committed rows each connected client receives, and when it must reload instead.

* `publish(event)`: an event with a `paneId` must be a `PaneSignal`; it is appended with `store.append(paneId, [{ event }])`, retried 3 times on `Schedule.exponential(Duration.millis(20))`. After the retries it is logged at error and `ReloadHistoryFrame{ paneId }` is fanned out. It reaches subscribers only through `store.committed`. An event without a `paneId` is fanned out as a `GlobalEventFrame` as today.
* Fan-out: one fiber reads `store.committed` and publishes `PaneEventFrame{ paneId: agentId, seq: sequence, event }`, where `event` is the `PaneSignal`, or `PaneAgentEvent.make({ paneId, agentEvent })`.
* At layer build it reads `hostStartSequence` from `store.highestSequence` (on failure: 0).
* `subscribe(cursors)`: subscribes to the PubSub first; then, for each cursor, calls `store.readAfter(paneId, cursor, REPLAY_LIMITS)`. On `Replay`: if `0 < cursor <= hostStartSequence`, sends `ReloadHistoryFrame`, because the client holds signal state (`isLoading`, attention, queue, open permission prompts) from a Host run that has ended and no row after the cursor corrects it; otherwise sends the replayed frames. On `ReloadRequired`, sends `ReloadHistoryFrame`. Live frames for the pane are then filtered to `seq > through`. Panes without a cursor get only live frames. Each decision is logged at debug with `paneId`, cursor, outcome (`replayed N` or `reload: <reason>`), and elapsed time.
* `REPLAY_LIMITS = { maxEvents: 128, maxBytes: 1_048_576 }`, exported, matching T3 Code (`THREAD_RESUME_MAX_REPLAY_EVENTS`, `THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES`, `apps/server/src/orchestration-v2/ThreadStream.ts:14,16`).
* `lastSeq`, `DEFAULT_REPLAY_BUFFER_SIZE` and the in-memory buffers are removed.

### `AgentEventRecorder` (`src/host/services/agent-event-recorder.ts`) — owns the mapping from `OutboundMessage` to conversation events

* New `catchUp({ agentId, cwd, sessionId }): Effect<Option<SessionId>>`: the transcript catch-up `open` runs today, as its own method. Returns `Some(sessionId)` when the agent owns that session's cursor (caught up, or the cursor's size and mtime matched), `None` when there is no transcript or catch-up failed (logged at warning). `open` calls it and keeps today's `ownedSession` / `catchUpFailed` handling; `seed` ignores the result.
* Maps `ConversationReset` to `ConversationCleared` before its `SessionBound`, and `RewoundToCheckpoint{messageUuid}` to `ConversationRewound{ checkpointUuid: messageUuid }`. Both first close any open text or reasoning item and clear `openTools`, so no later write re-creates an item the projection deleted.
* A streaming text or reasoning item whose last delta was not written is written by a timer at `lastWriteAt + STREAMING_WRITE_INTERVAL`, so shown text is at most 50 ms behind while deltas pause. The timer and every other write run under one recorder semaphore that also guards `state.text` / `state.reasoning`; the timer writes only if the field still holds the same item, and closing clears the field before writing `streaming: false`. A late `streaming: true` can therefore never follow the item's final row.
* A `CheckpointAvailable` with no user message awaiting one is logged, as today; that message keeps no `checkpointUuid` (the removed `PaneCheckpointAvailable` anchored it by order).

### `PaneSupervisor` (`src/host/services/pane-supervisor.ts`) — one ordered path for what a pane's session produces

* `outbound` becomes `Queue<PaneOutput>`, `PaneOutput = Data.TaggedEnum<{ Publish: { event: IpcEvent }; Record: { message: OutboundMessage } }>`. Every existing `Queue.offer(outbound, e)` offers `Publish{ event: e }`.
* `emit` offers `Record{ message }` and then runs `handleSessionEvent(message)` (which offers its `Publish`es). The single consumer runs `record(message)` for `Record` and `onEvent(event)` for `Publish`, in order. A message's conversation rows therefore commit before its signals, and before any later message's rows; a rewind or reset commits before the next turn's items.
* Ordering is guaranteed only among items of one pane's `outbound` queue. Events published outside it (`tab-setup.ts` progress and notices during `openPane`, `PaneCreateFailed` in `rpc-handlers.ts`, `emitErrored` in `pane-workspace.ts`, `selectTab`) carry no conversation dependency and commit through `store.append` independently. The recorder's streaming timer and close-time writes commit through the store semaphore under the recorder semaphore, so none precedes a row it depends on.
* `toIpcEvent` no longer maps `AssistantMessageReceived`, `AssistantTextDelta`, `AssistantThinkingDelta`, `ToolCallStarted`, `ToolCallCompleted` or `CheckpointAvailable`.

### `PaneChatProjection` (`src/host/services/pane-chat-projection.ts`)

* `seed(paneId)`: for a workspace tab with a session, runs `recorder.catchUp(...)` without the lock. Then, under the lock `foldFrame` takes, runs `store.readHistory(paneId)` and inserts `paneChatStateFromItems(items)` at `seq = through`. Rows catch-up committed are at or below `through`, so the fold skips them. The lock is held for one read transaction and one insert, so one pane's import does not delay another pane's fold. A failed read is logged at error and seeds the empty state at `seq 0`. Depends on `AgentEventStore` and `AgentEventRecorder`, not `TranscriptReader` or `EventHub.lastSeq`.
* `snapshot` waits for `store.lastSequence(paneId)` (on failure: logged, target 0).

### `pane-chat.ts` (`src/shared/domain/pane-chat.ts`)

* `paneChatStateFromItems(items)` replaces `paneChatStateFromHistory`. A user `MessageItem` is one user `PaneMessage` with `id = itemId`. Consecutive assistant-side items (assistant `MessageItem`, `ReasoningItem`, `ToolCallItem`) form one assistant `PaneMessage` whose `id` is its first item's id, with one `text`, `thinking` or `tool-call` part each.
* `paneChatStateFromItems` is the state of a cold pane: `isLoading: false`, attention `Idle`. A `ToolCallItem` with `running: true` (left by a killed Host) becomes a `done` part with no `output`; a `streaming: true` item becomes a finished part. Every user message is rewindable and none has `resumedAt`. The reducer and `paneChatStateFromItems` build equal `parts` for the same items, not equal message grouping or ids; a test folds rows through the reducer and compares each message's `parts`.
* `TextPart` and `ThinkingPart` gain `itemId: Schema.optional(Schema.String)`; a tool-call part's item id is its `toolCallId`.
* `PaneStreamEvent` and `STREAM_EVENT_TAGS` replace the six removed tags with `PaneAgentEvent`. `reducePaneChat` on `PaneAgentEvent`:
  * `MessageUpdated` (user): merges `checkpointUuid`, `resumeAnchorUuid` and `attachments` into the message with `id = itemId`, keeping its `rewindable` and `resumedAt`; or appends a user message.
  * `MessageUpdated` (assistant) / `ReasoningUpdated`: replaces the content of the part with that `itemId`; otherwise appends a part to the trailing assistant message, or opens one. Opening sets `isLoading` only when `streaming`.
  * `ToolCallStarted`: appends a running tool-call part unless one with that id exists; `isLoading` unchanged (`PaneUserMessagesSent` and a streaming `MessageUpdated` set it), so rows a catch-up imports into a live atom leave an idle pane idle.
  * `ToolCallCompleted`: completes the part in place, or appends a done part; `isLoading` unchanged.
  * Other `AgentEvent`s: state unchanged.
* `PaneUserMessagesSent` uses `id = message.id`. It finds the first sent message's id in `messages`; the park notice and `resumesPark` are judged against the message immediately before it, not `messages.at(-1)`. For a present id it sets `rewindable: false` (index > 0) and `resumedAt` on it and resolves the park notice before it; for an absent id it appends as today. It sets `isLoading` and clears `turnStatus`. A test parks, sends `RESUME_TEXT`, and expects the notice resolved and `resumedAt` set.
* The removed events' cases and `anchorCheckpoint` are deleted.

### `agent-summary.ts` (`src/shared/domain/agent-summary.ts`)

`foldSummary` reads tool activity from `PaneAgentEvent` with `ToolCallStarted` / `ToolCallCompleted`.

## Error handling

| Failure | Result |
| --- | --- |
| `publish` append fails 3 retries | Logged at error; `ReloadHistoryFrame` to clients |
| `readAfter` fails or a row does not decode | `ReloadHistoryFrame` for that pane |
| `readHistory` fails in `seed` | Logged at error; empty state at `seq 0` |
| Catch-up fails in `seed` | Logged at warning (as in `open` today); seed reads what is stored |

## Cost

Opening an agent never opened since #164 imports its whole transcript in `seed`, and every imported row is fanned out once. The renderer drops them by `seq <= floor`. `PaneChatProjection` skips them by `seq`. `AgentSummaries` folds them: the import replaces the agent's saved activity line with the transcript's last tool call and publishes `AgentSummaryChanged`.

## Limitations

* The transcript shown after a Host restart contains conversation items only. Notices (session, model change, compaction, park) and error turns come from signals, which `agent_items` does not hold, so they are absent after a restart, as they are today. Replay within one Host run includes them.
* Replay serves reconnects within one Host run, and cursor 0. A cursor from before a Host restart reloads. A pane with no row after Host start holds a cursor at or below `hostStartSequence`, so each reconnect reloads its snapshot.
* Signal rows (`PaneToolCallUpdated`, `PaneTurnStatusChanged`, `PaneContextUsageChanged`, …) are stored and archive compaction does not remove them; ADR-0052 lists this as a consequence.

## Measurement

Before: time `TranscriptReader.readHistory` for the longest local session. After: time `AgentEventStore.readHistory` for the same session after catch-up. Record both, with the entry count and file size, in ADR-0052, and replace ADR-0051's `<!-- unverified -->` marker with a reference to it.

## JSDoc and logging

Every new export has a JSDoc comment: `PaneAgentEvent`, `PaneSignal`, `ConversationCleared`, `ConversationRewound`, `StoredEvent`, `CommittedEvent`, `Replay`, `ReloadRequired`, `committed`, `readAfter`, `readHistory`, `lastSequence`, `highestSequence`, `catchUp`, `REPLAY_LIMITS`, `paneChatStateFromItems`.

## Success criteria → tests

| # | Criterion | Test |
| --- | --- | --- |
| 1 | Frame `seq` = row `sequence` | `event-hub.test.ts` |
| 2 | After a Host restart over the same db, a cursor from before the restart reloads; a cursor from after it replays | `event-hub.test.ts`: a second `EventHubLive` built over a store that already holds rows |
| 3 | >128 events, >1 MiB, cursor ahead, undecodable row → `ReloadHistory` | `agent-event-store.test.ts`, `event-hub.test.ts` |
| 4 | Shown text ≤50 ms behind; final text whole; no `streaming:true` after the final row | `agent-event-recorder.test.ts` (TestClock), `pane-chat.test.ts`; app |
| 5 | Tool calls from before Host start in `GetPaneChat` | `pane-chat-projection.test.ts`; app |
| 6 | No `TranscriptReader.readHistory` on open | `pane-chat-projection.test.ts` provides no `TranscriptReader` |
| 7 | Load times recorded | ADR-0052 |
| 8 | A rewind or reset followed by a new user message keeps the new message's item | `pane-supervisor.test.ts` |
| 9 | `committed` order equals commit order under concurrent appends | `agent-event-store.test.ts` |
| 10 | A frame committed during `seed` is folded once | `pane-chat-projection.test.ts` |
| 11 | Orphan rows are deleted at store build | `agent-event-store.test.ts` |
| 12 | An unopened tab with a session shows its transcript on first snapshot | `pane-chat-projection.test.ts` |
| 13 | One pane's catch-up does not delay another pane's fold | `pane-chat-projection.test.ts` |
| 14 | Park, resume: notice resolved, `resumedAt` set | `pane-chat.test.ts` |
| 15 | Imported `ToolCallStarted`, `ToolCallCompleted`, `MessageUpdated{streaming:false}` folded into an idle state leave `isLoading: false` | `pane-chat.test.ts` |

Existing tests to update: every `EventHub` stub drops `lastSeq` (`rpc-handlers`, `adapter-status-feed`, `model-catalog-feed`, `pane-workspace` tests); `agent-event-store.test.ts` reads through `readHistory`; `pane-chat.test.ts` and `pane-chat-atoms.test.ts` replace the six removed tags with `PaneAgentEvent` and `paneChatStateFromHistory` with `paneChatStateFromItems`; `event-hub.test.ts` drops the buffer-size cases; `host-api.test.ts`, `host-server.test.ts`, `turn-activity.test.ts`, `agent-summary.test.ts`, `agent-summaries.test.ts`, `pane-supervisor.test.ts` and `agent-event-recorder.test.ts` use `PaneAgentEvent` and the new recorder API.

## Refinement record

Round 1 (sonnet): 18 findings.

| # | Finding | Tag | Decision |
| --- | --- | --- | --- |
| 1 | Recorder writes and queued signals commit in scheduler order | blocker | Applied as one ordered queue with `Record` items, keeping the recorder as the writer (keeps its cursor-stall feedback) |
| 2 | `committed` order not guaranteed | blocker | Applied (semaphore) |
| 3 | Orphan rows for panes with no `agents` row | blocker | Applied as a prune at store build only |
| 4 | Catch-up after seed; unopened tabs seed empty | blocker | Applied (`catchUp` in `seed`) |
| 5 | Replay across restart restores stale signal state | major | Applied (`hostStartSequence` rule); superseded by round 2 F1 |
| 6 | `readAfter` gap between reads; undecodable rows; byte length | major | Applied |
| 7 | Flush timer can write `streaming:true` after close | major | Applied (recorder semaphore) |
| 8 | Failed append drops events silently | major | Applied (retry, then reload) |
| 9 | Reducer gaps (`isLoading`, ids, `STREAM_EVENT_TAGS`, orphan checkpoint) | major | Applied |
| 10 | Consumers and doc comments to update | minor | Applied |
| 11 | Wrong ADR-0051 supersession wording | minor | Applied |
| 12 | Hand-declared types | major | Applied (schemas, two-member read result) |
| 13 | Logging, JSDoc, missing tests | major | Applied |
| 14 | `event.event` nesting | minor | Applied (`agentEvent`) |
| 15 | Store knew wire events (Information Hiding) | major | Applied (`ConversationCleared`, `ConversationRewound`) |
| 16 | Three reload outcomes; `lastSeq` hides failure | minor | Applied |
| 17 | Hub knowledge line | minor | Applied |
| 18 | Rule wording | minor | Applied |

Round 2 (sonnet): 10 findings.

| # | Finding | Tag | Decision |
| --- | --- | --- | --- |
| F1 | Round-1 restart rule leaves the renderer's own stale state | blocker | Applied (any cursor from before the restart reloads); escalated, accepted by the user at the gate |
| F2 | Park notice not resolved when the user row precedes the signal | major | Applied |
| F3 | `catchUp` under the shared projection lock stalls other panes | major | Applied |
| F4 | `catchUp` returning `void` loses `open`'s ownership result | major | Applied |
| F5 | "One ordered path per pane" overstated | major | Applied (wording, scope of guarantee) |
| F6 | `fromItems` vs reducer; stuck running items after a kill | major | Applied |
| F7 | Notices lost after restart unstated | minor | Applied (Limitations) |
| F8 | `PaneSignal` not enumerated | minor | Applied |
| F9 | `committed` buffering and lock order | minor | Applied |
| F10 | Import folds into `AgentSummaries` | minor | Applied (stated in Cost) |

Round 3 (sonnet): 6 findings.

| # | Finding | Tag | Decision |
| --- | --- | --- | --- |
| F1 | `ToolCallStarted` setting `isLoading` sticks after an import into a live atom | major | Applied |
| F2 | Existing tests that break not listed | major | Applied |
| F3 | ADR-0051 "one page" consequence and compaction not listed as amended | minor | Applied |
| F4 | Byte sum scans every payload in range | minor | Applied (count first) |
| F5 | Rewind or reset while an item is open re-creates it | minor | Applied (close first) |
| F6 | Reconnect reload for panes idle since Host start undocumented | minor | Applied (Limitations) |
