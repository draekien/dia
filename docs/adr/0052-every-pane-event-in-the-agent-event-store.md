---
status: "accepted"
date: 2026-11-05
decision-makers: William Pei
---

# Store every pane event in `agent_events` and send the renderer item updates instead of deltas

## Context and Problem Statement

ADR-0051 makes `PaneEventFrame.seq` an `agent_events.sequence` and replays `SubscribeEvents` cursors from `agent_events`. `agent_events` stores only conversation events (`MessageUpdated`, `ReasoningUpdated`, tool calls, `SessionBound`, archive events). A pane's frames also carry per-token text and thinking deltas and signals that `agent_events` does not store: turn status, attention, the message queue, permission and question requests, notices, model changes, context usage and setup progress. A frame without a stored row has no sequence, and a cursor replay from `agent_events` cannot resend it. How does every pane frame get a stored sequence, so that replay from `agent_events` resends every frame a client missed?

## Decision Drivers

* Every pane frame has a sequence number that survives a Host restart, so a resubscribing client resumes from its cursor (#156).
* Per-token deltas are not stored (ADR-0051, Content).
* Recorder writes, signals and the frames sent to clients are in one order, so a client folds the same state the Host's `PaneChatProjection` folds.
* Opening an agent does not parse its transcript (ADR-0051).

## Considered Options

* Store every pane event in `agent_events` and send the renderer stored item updates instead of deltas (T3 Code's model)
* Store only conversation events; keep a separate in-memory sequence for signals and deltas
* Keep ADR-0022's in-memory replay buffer and add `agent_events` only as the history source

## Decision Outcome

Chosen option: "Store every pane event in `agent_events` and send the renderer stored item updates instead of deltas", because it is the only option where one sequence orders every frame and replay survives a restart.

### Wire

* The six content events `PaneAssistantTextDelta`, `PaneAssistantThinkingDelta`, `PaneToolCallStarted`, `PaneToolCallCompleted`, `PaneMessageAppended` and `PaneCheckpointAvailable` are removed. `PaneAgentEvent{paneId, agentEvent}` carries each stored `AgentEvent` instead. `PROTOCOL_VERSION` is `0.0.23`.
* Every other pane-scoped `IpcEvent` is a member of `PaneSignal` (`src/shared/ipc/contract.ts`). `EventHub.publish` stores a `PaneSignal` in the pane's stream as a row with no item, then delivers it with that row's sequence.
* Text and thinking reach the renderer as `MessageUpdated` and `ReasoningUpdated` item updates. The recorder writes one update when a span opens, then at most one per `STREAMING_WRITE_INTERVAL` (50 ms) after the last write, then one final update with `streaming: false`. The renderer replaces the item's text with each update.
* `/clear` and rewind are stored as `ConversationCleared` and `ConversationRewound{checkpointUuid}`. Their projections delete the agent's items, or the items from the user message holding that checkpoint onward.

### Ordering

* `AgentEventStore` publishes each committed row on `committed` after its transaction commits, under one write permit, so `committed` is in sequence order. `EventHub` builds every pane frame from `committed`.
* The pane supervisor puts recorder writes and published signals in one queue per pane, drained by one fiber, so a rewind's `ConversationRewound` commits before the user message sent after it.

### Replay

* A cursor replays the rows after it when there are at most 128 rows and 1 MiB of stored JSON (`REPLAY_LIMITS`, T3 Code's `THREAD_RESUME_MAX_REPLAY_EVENTS` and `THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES`). Otherwise the client is sent `ReloadHistoryFrame`: more rows or bytes, a cursor past the pane's last row, a row that does not decode, or a failed read.
* A cursor from before this Host started (greater than 0 and at most the highest sequence at start) is sent `ReloadHistoryFrame`. Signals from an ended run describe a session that no longer exists; the client reloads the snapshot instead of folding them.
* When a signal cannot be stored after 3 retries, subscribers are sent `ReloadHistoryFrame` for that pane.

### Seeding

* `PaneChatProjection.seed` first calls `AgentEventRecorder.catchUp` for a tab with a session, outside the projection's lock, so one tab's transcript read does not delay another tab. It then reads `AgentEventStore.readHistory` and inserts the state at the history's last sequence under the lock. `TranscriptReader.readHistory` is no longer called on open.
* Rows for agent ids with no `agents` row are deleted when the store is built.

### Load time

Measured on the longest local session (`573b5695-…`, cwd `F:\Dev\dia`, 19,760,700 bytes, 6,615 JSONL lines), Windows 11, NVMe SSD:

| Path | Result | Times |
| --- | --- | --- |
| Before: `TranscriptReader.readHistory` on every open | 38 text-only messages | 86.9, 59.6, 57.7, 58.8, 54.6 ms |
| After: first open, `catchUp` imports the whole transcript | 200 items | 105.5 ms, once per session |
| After: later opens, `catchUp` finds the cursor current | — | 2.1, 1.8, 1.8 ms |
| After: `AgentEventStore.readHistory` | 200 items with tool calls and thinking | 2.5, 1.8, 1.6, 1.7, 1.5 ms |

### Consequences

* Good, because every pane frame has a stored sequence, and replay survives a Host restart.
* Good, because a pane opened after its first import loads in about 4 ms instead of about 60 ms, with tool calls and thinking.
* Good, because the renderer and `PaneChatProjection` fold the same ordered stream.
* Bad, because `agent_events` stores signals that only describe the live session (turn status, attention, queue). They are never projected into items and are deleted only with the agent.
* Bad, because shown text lags the model by up to 50 ms, as T3 Code's does.
* Bad, because a renderer from before `0.0.23` cannot connect to this Host (`CLOSE_PROTOCOL_MISMATCH`).

## Pros and Cons of the Options

### Store every pane event in `agent_events` and send the renderer stored item updates instead of deltas

* Good, because one sequence orders every frame.
* Bad, because every signal is a SQLite commit.

### Store only conversation events; keep a separate in-memory sequence for signals and deltas

* Good, because signals cost no commit.
* Bad, because a frame has one of two sequences, and the in-memory one restarts with the Host, so a cursor cannot say which frames a client missed.

### Keep ADR-0022's in-memory replay buffer and add `agent_events` only as the history source

* Good, because the wire is unchanged.
* Bad, because a Host restart loses the buffer, and the frames' sequences are not `agent_events` sequences, which ADR-0051 requires.

## More Information

* Amends ADR-0051, "Replay to the renderer" and "Content": the replay limit is 128 events or 1 MiB, and signals are stored.
* Amends ADR-0022: replay uses stored sequences, which are increasing per pane but not contiguous.
* Amends ADR-0050: `seed` catches a tab up and reads `agent_items`; `snapshot` waits for the pane's last stored sequence.
* Design: `docs/designs/pane-event-store-replay.md`.
* Reference implementation: T3 Code (`F:\Dev\dia\.repos\t3code`, `apps/server/src`), `orchestration-v2/ThreadStream.ts` (replay limits), `ws.ts` (resume and snapshot fallback), `ThreadLiveEventCoalescer` (50 ms updates).
