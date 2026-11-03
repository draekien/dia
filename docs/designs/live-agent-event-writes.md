# Live agent event writes

Writes each live pane session's conversation (user turns, assistant text, thinking, tool calls, session bindings) to `AgentEventStore`, and keeps the session's transcript cursor at the end of the turns it wrote, so a Host restart loses no conversation dia showed and catch-up (#155) reads only turns dia did not run. Issue #154, ADR-0051 "Content".

## Scope

In: the recorder service, its call from `PaneSupervisor`, protocol source-id fields, cursor read/write on `AgentEventStore`, `TranscriptReader.readTranscriptAfter`, a `host.db` trigger that deletes an agent's event rows.

Out:
- Rendering or replay from the store (#156). #156 must treat a `streaming` row of an agent with no live session as final: a Host crash (not a pane close) leaves such rows.
- Catch-up on open and interrupted tool calls in the transcript path (#155).
- Rewind forks. A rewind forks into a new session id and emits `SessionStarted` again (`forkSession`, `plugins/claude-code/session.ts:528`); #155 (`docs/designs/transcript-catch-up.md`) makes the recorder own the fork's cursor and skips catch-up entries whose source uuid the agent already stored.
- Archive (#158). `SessionBound` on compaction (the session id does not change).

## Interface

### `src/host/services/agent-event-recorder.ts` (new)

```ts
/** Service tag for writing a live pane session's conversation to `AgentEventStore`. Provide with AgentEventRecorderLive. */
export class AgentEventRecorder extends Context.Service<AgentEventRecorder, {
  /**
   * Starts recording the session of agent `agentId` (the pane id), working in `cwd`. `resume`
   * is the SDK session the pane resumes, or none for a new conversation. Call it before the
   * session starts. Returns the function to call
   * with every OutboundMessage the session emits, in order. Recording lives in the surrounding
   * scope; closing it finalises open items. The returned function never fails: a failed write is
   * logged, and the transcript cursor stops advancing for the rest of the recording.
   */
  readonly open: (options: {
    readonly agentId: string
    readonly cwd: string
    readonly resume: Option.Option<SessionId>
  }) => Effect.Effect<(message: OutboundMessage) => Effect.Effect<void>, never, Scope.Scope>
}>()('AgentEventRecorder') {}

/** The recorder over AgentEventStore, TranscriptReader, Clock and Crypto. */
export const AgentEventRecorderLive: Layer.Layer<AgentEventRecorder, never, AgentEventStore | TranscriptReader | Crypto.Crypto>

/** Shortest time between two streaming writes of one item. */
export const STREAMING_WRITE_INTERVAL = Duration.millis(50)
```

### Message → event mapping (per recorder)

| OutboundMessage | Events appended |
| --- | --- |
| `AssistantThinkingDelta{text}` | Opens a reasoning item (new random item id) if none is open; appends text; writes `ReasoningUpdated{streaming:true}` with the text so far when none was written for this item in the last `STREAMING_WRITE_INTERVAL` (the first delta always writes). |
| `AssistantTextDelta{text}` | Closes an open reasoning item; same as thinking for a text item: `MessageUpdated{role:'assistant', streaming:true}`. |
| `AssistantMessageReceived{message, sourceId?}` | Closes an open reasoning item; writes `MessageUpdated{message, streaming:false}` under the open text item's id (a new id when none is open, e.g. `local_command_output`), `sourceUuid = sourceId`; the text item is then closed. |
| `ToolCallStarted{toolCallId, toolName}` | Closes an open reasoning item; `ToolCallStarted` (item id = `toolCallId`); the call joins the set of open tool calls. |
| `ToolCallCompleted{…, sourceId?}` | `ToolCallCompleted` with `output = capToolOutput(output)`, `sourceUuid = sourceId`; the call leaves the open set. |
| `UserMessagesSent{messages}` | Per message, in order: `MessageUpdated{itemId: message.id, message:{role:'user', content: text, attachments?}, streaming:false}`; `{ itemId, message }` joins the queue of user items awaiting a checkpoint.  |
| `CheckpointAvailable{messageUuid, resumeAnchorUuid?}` | Takes the first queued user item (the renderer's rule, `anchorCheckpoint`, `src/shared/domain/pane-chat.ts:489`) and writes `MessageUpdated` for it again with its message plus `checkpointUuid: messageUuid`, `resumeAnchorUuid`, `sourceUuid = messageUuid`. Empty queue: logged and ignored. |
| `SessionStarted{sessionId}`, `ConversationReset{newSessionId}` | `SessionBound{sessionId}` when it differs from the last id this recorder bound. |
| `TurnCompleted`, `TurnErrored`, `TurnParked` | Closes open reasoning and text items (`streaming:false` with the text so far); then queues a cursor update (below). |
| anything else | nothing |

A "close" writes the item's final event with `streaming:false` and the full text. Events of one message are appended in one `append` call. Subagent text reaches the stream as `AssistantMessageReceived` (`plugins/claude-code/reducer.ts:437-452` does not filter it) and is recorded as the live pane shows it; the transcript path omits subagent messages. Assumption (unverified): `AssistantMessageReceived` for a text block arrives before the next block's first delta.

### Cursor ownership

Superseded by #155: the recorder owns the cursor of the session it last bound, and of the `resume` session from `open` when catch-up of it succeeded. See "Ownership" in `docs/designs/transcript-catch-up.md`.

### Cursor updates

Updates run on one fiber that drains a queue, so they apply in order. `open` forks it with `Effect.forkDetach`, so it has no finalizer of its own and only the scope-close finalizer ends it. A failed write sets the recorder's `cursorStalled` flag, which is never cleared while the recorder lives; while it is set no cursor update is offered, including the scope-close one, so the next `open` of the agent finds the transcript changed since the cursor and catches it up. At each turn end of an owned, unstalled session, the recorder offers the session id. The fiber reads `readTranscriptAfter(sessionId, cwd, cursor.lastUuid)` (from the start when no row exists) and, on `Some(tail)`, writes `{ sessionId, lastUuid, fileSize, mtimeMs }`, where `lastUuid` is the last entry's sourceUuid, or the stored cursor's when the tail has no entries (#155, `docs/reasoning/2026-11-03-resume-touches-transcript.md`); with no entries and no stored cursor it writes nothing. The entries are not appended. The tail's entries are main-chain user and assistant entries only (`transcriptEntriesAfter`), so `lastUuid` is always an id catch-up can find. Each update parses the whole transcript through the SDK on the Host event loop; accepted, revisit if profiling shows it.

### Scope close

`open` registers finalizer 2 before finalizer 1; a scope closes its finalizers in reverse registration order (`node_modules/effect/src/internal/effect.ts:4029`, sequential by default), so they run in this order:
1. Write the final event of each open reasoning or text item (`streaming:false`, text so far) and `ToolCallCompleted{output:'', isError:false}` with no source for each open tool call (the live reducer's turn-end flush does the same, `reducer.ts:269`).
2. For an owned session, offer one last cursor update (the CLI may write a turn's last entries after the turn-end read), end the queue, and join the drain fiber, so no offered update is dropped.

Unverified: whether a pane's scope always closes before `WorkspaceStore` deletes its `agents` row; a write after the delete leaves rows the trigger already cleared.

### `src/host/services/agent-event-store.ts` (extended)

```ts
/** Where catch-up resumes reading session `sessionId`'s transcript. */
export const TranscriptCursor = Schema.Struct({ sessionId: SessionId, lastUuid: Schema.String, fileSize: Schema.Int, mtimeMs: Schema.Int })
export type TranscriptCursor = typeof TranscriptCursor.Type

readonly readCursor: (sessionId: SessionId) => Effect.Effect<Option.Option<TranscriptCursor>, AgentEventReadError>
readonly writeCursor: (cursor: TranscriptCursor) => Effect.Effect<void, AgentEventWriteError>   // upsert
```

### `src/host/services/transcript-reader.ts` (extended)

```ts
/** AgentBackend.readTranscriptAfter of the loaded adapter; none, logged, when no adapter is loaded. Never fails. */
readonly readTranscriptAfter: (sessionId: SessionId, cwd: string, afterUuid: Option.Option<string>) => Effect.Effect<Option.Option<TranscriptTail>>
```

### `src/host/session/protocol.ts` (fields added)

- `AssistantMessageReceived.sourceId: optional String` — the id of the message in the provider's transcript that the text came from.
- `ToolCallCompleted.sourceId: optional String` — the id of the provider transcript message that carried the result; absent for a call completed without a result.

`plugins/claude-code/reducer.ts` fills both (assistant `message.uuid`; `local_command_output` system message `uuid`, required at `sdk.d.ts:5531`; tool_result user `message.uuid`, optional at `sdk.d.ts:6624`). `toIpcEvent` copies fields by name (`pane-supervisor.ts:224`), so IPC events and `PROTOCOL_VERSION` are unchanged. The plugin API stayed `0.0.18`, introduced by #161; #155 raised it to `0.0.19` for `AgentBackend.transcriptInfo`.

### `src/host/services/pane-supervisor.ts`

`startPane` opens the recorder in the pane scope with `{ agentId: config.paneId, cwd: config.cwd, resume }` before `factory.start`, and the `emit` it passes to `factory.start` records each message after `handleSessionEvent` handles it, so the renderer receives it before the `host.db` write.

### `src/host/services/kernel-migrations.ts`

New migration `4_agent_event_cleanup`:

```sql
CREATE TRIGGER agents_delete_events BEFORE DELETE ON agents BEGIN
  DELETE FROM agent_transcript_cursors WHERE session_id IN (SELECT session_id FROM agent_sessions WHERE agent_id = OLD.agent_id);
  DELETE FROM agent_events WHERE agent_id = OLD.agent_id;
  DELETE FROM agent_items  WHERE agent_id = OLD.agent_id;
END
```

`BEFORE` so `agent_sessions` rows still exist; `foreign_keys = ON` (`database.ts:49`) and SQLite fires delete triggers on cascade deletes, so it covers `deleteGone`, `deleteUnreadable`, and a project delete's cascade.

## Design Rationale

**Cursor instead of shared item ids** — the stream is the record of the turns dia runs; catch-up exists only for turns that never passed through it (terminal turns, agents from before #154, OS-crash loss). Advancing the cursor past dia's own turns means live and imported items never describe the same message, so live item ids can be random and #153's ids stay as they are (user decision).

**The tail's last entry as `lastUuid`** — a source id seen on the stream can be a system message (`local_command_output`) or a subagent message, neither of which `getSessionMessages` returns; the tail's entries are always main-chain entries. The single ordered worker keeps a slow read from overwriting a newer cursor.

**Source ids in the protocol** — `source_uuid` is set on every final event that came from a complete provider message (user decision). Streaming events and reasoning have none: no complete message exists for them on the stream.

**Throttle, not timer** — a streaming write happens on a delta when 50 ms have passed since the item's last write. No fiber per item; the final event always carries the full text, so a skipped trailing partial is never the last state written.

**Trigger for deletion** — agent rows are deleted in three places, one of them a foreign-key cascade; a trigger covers all of them and future ones.

**Recorder separate from the store** — the store owns tables and transactions; the recorder owns the mapping from one pane's message stream to events and its per-session state (open items, open tool calls, checkpoint queue, bound session id, turn state).

## Refinement Record

**Applied (round 1)**
- blocker (correctness) — forked cursor updates could apply out of order; now one queue, one fiber, and `lastUuid` is the turn's last written source id.
- blocker (correctness) — a failed write no longer lets its turn advance the cursor.
- major (correctness) — scope finalizer closes open items and open tool calls; delete-vs-finalizer order recorded as unverified.
- major (correctness) — rewind fork ownership moved to Out with the duplicate hazard for #155.
- major (correctness) — the checkpoint queue holds `{ itemId, message }`.
- minor — subagent text parity and delta-order assumption stated; `startPane`; parse cost accepted; provider-neutral `sourceId` naming; plugin API claim cited.

**Applied (round 2)**
- blocker (correctness) — a stream source id can be a system or subagent uuid absent from `getSessionMessages`; `lastUuid` is now the tail's last entry.
- major (correctness) — scope close queues a last update, ends the queue and joins the drain fiber.
- major (correctness) — a resumed session with a cursor is owned only when nothing follows the cursor at bind time.
- minor (project rule) — `TranscriptCursor` type derived from its schema.

**Rejected**
- round 1's "last written source id as `lastUuid`" — superseded by the round-2 blocker above.

**Applied (round 3)**
- major (correctness) — a failed write stalled only its own turn, so a later turn's cursor update skipped it; the stall now lasts for the recorder's life.
- minor (correctness) — the drain fiber is forked detached and the finalizer registration order is stated.
