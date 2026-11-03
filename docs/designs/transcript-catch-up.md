# Transcript catch-up on open

When a pane opens an agent that resumes an SDK session, dia appends the session's transcript entries it has not stored yet (turns added outside dia, for example by `claude --resume <id>` in a terminal, or a whole transcript of an agent from before ADR-0051) to `AgentEventStore`, then records the session live and owns its cursor. Issue #155, ADR-0051 "Catch-up on open".

## Scope

In: `AgentBackend.transcriptInfo` and its claude-code implementation, `TranscriptReader.transcriptInfo`, `AgentEventStore.appendTranscript`, catch-up and a single ownership rule in `AgentEventRecorder`. Docs made true again: `docs/designs/live-agent-event-writes.md` (the Out bullet on rewind forks, "Cursor ownership", "Cursor updates"), `docs/reasoning/2026-11-03-clear-session-id.md` and its `docs/REASONING.md` row (the `newConversationPending` clause), ADR-0051 "Catch-up on open", amended to read size and mtime through `AgentBackend.transcriptInfo`; in the #154 design also the plugin-API-version sentence and the `cursorStalled` sentence ("leaves the session to catch-up"), and in `docs/reasoning/2026-11-03-transcript-tail-through-the-sdk.md` the `append` that skips stored entries becomes `appendTranscript`. Every `AgentBackend` and `TranscriptReader` test stub gains `transcriptInfo`.

Out:
- Rendering from `agent_items` (#156). The pane keeps reading its history through `TranscriptReader.readHistory`.
- Creating agents from discovered sessions (#157); it can call `appendTranscript` with a whole tail. Assumes at most one agent per SDK session id, because `agent_transcript_cursors` is keyed by session: #157 must refuse to import a session that already has a cursor.
- Completing a `tool_use` that has no `tool_result`. A scan of 216 local transcripts found such a `tool_use` only as the last entry of a running session; an interrupted or rejected call gets an `is_error` `tool_result` from the CLI (`docs/reasoning/2026-11-03-interrupted-tool-results.md`).
- Live thinking, streamed text and tool-call starts carry no source uuid. When catch-up reads a turn that was recorded live (a stalled cursor, a Host kill before the turn-end cursor update), it stores that turn's thinking again as item `<uuid>:thinking` (each content block is its own JSONL entry with its own uuid, confirmed on a real transcript in #153, so a thinking entry never shares the uuid of the stored text), and after a kill mid-stream also its text under the transcript uuid. A tool call is not duplicated as an item, because both paths use the `tool_use` id and the projection keeps the first. The killed turn's live items stay `streaming`. Accepted.
- `SessionBound` before caught-up entries of an agent whose stream has none (an agent from before ADR-0051); the recorder writes `SessionBound` when the session starts, after the caught-up entries.

## Interface

### `src/host/session/agent-backend.ts`

```ts
/** The size (bytes) and modification time (epoch ms) of an SDK session's transcript file. */
export interface TranscriptInfo {
  readonly fileSize: number
  readonly mtimeMs: number
}

/** A session's transcript entries after a given entry, with the transcript file's size and mtime as they were before the entries were read. */
export interface TranscriptTail extends TranscriptInfo {
  readonly entries: ReadonlyArray<TranscriptEntry>
}

// AgentBackend gains (required):
/**
 * The size and modification time of `sessionId`'s transcript under `cwd`, without reading its
 * entries. None, logged, when there is no readable transcript file. Never fails.
 */
readonly transcriptInfo: (sessionId: SessionId, cwd: string) => Effect.Effect<Option.Option<TranscriptInfo>>
```

`unavailableBackend.transcriptInfo` returns none with a warning; `'transcriptInfo'` joins `backendMethods`; the `AgentBackend` summary JSDoc and `resolveAgentBackend`'s list of unavailable-backend behaviours name it. `plugin-api.ts` exports the `TranscriptInfo` type. The plugin API version goes from `0.0.18` to `0.0.19` in `src/shared/plugin/manifest.ts` and the 8 `plugin.json` files, because an adapter without the new required member must be refused (ADR-0032: below 0.1.0 a plugin loads only on the same patch version).

### `plugins/claude-code/transcript.ts`

`transcriptInfo` calls `getSessionInfo(sessionId, { dir: cwd })` and returns `{ fileSize, mtimeMs: lastModified }`; none, with a warning, when it returns `undefined`, has no `fileSize`, or throws. `readTranscriptAfter` reads its size and mtime through the same helper, before `getSessionMessages`, so a file that grows during the read differs from the stored size at the next open. `backend.ts` wires it in.

### `src/host/services/transcript-reader.ts`

```ts
/** AgentBackend.transcriptInfo of the loaded adapter; none, logged, when no adapter is loaded. Never fails. */
readonly transcriptInfo: (sessionId: SessionId, cwd: string) => Effect.Effect<Option.Option<TranscriptInfo>>
```

### `src/host/services/agent-event-store.ts`

```ts
/** The least number of events one `appendTranscript` write commits together. A call that fails keeps the writes committed before the failure. */
export const TRANSCRIPT_BATCH_SIZE = 500

/**
 * Appends to agent `agentId` the entries of `tail`, read from SDK session `sessionId`'s
 * transcript, skipping each entry whose `sourceUuid` the agent already has an event for, then
 * stores the session's cursor at the tail's last entry (skipped or not) with the tail's size and
 * mtime. All events of one source uuid are stored together or not at all. A tail with no entries
 * updates only the size and mtime of an existing cursor, and stores nothing when none exists.
 * Fails with AgentEventReadError when the stored source uuids cannot be read, and with
 * AgentEventWriteError when a write fails; the entries stored before the failure stay, the cursor
 * is unchanged, and calling again with the same tail stores the rest.
 */
readonly appendTranscript: (
  agentId: string,
  sessionId: SessionId,
  tail: TranscriptTail
) => Effect.Effect<void, AgentEventWriteError | AgentEventReadError>
```

Each event goes through the same insert and projection as `append`, so `(agent_id, source_uuid, item_id)` still applies. Batches hold at least `TRANSCRIPT_BATCH_SIZE` events and end only where `sourceUuid` changes; the cursor is written in the last batch's transaction.

### `src/host/services/agent-event-recorder.ts`

`open`'s JSDoc gains: "When `resume` is some, first appends the entries of that session's transcript the agent has not stored. A failed catch-up is logged and does not fail `open`. While the pane still resumes that session, the next open retries it; once the pane persists another session id (a fork or a conversation reset), the entries of the failed session are imported only as far as that session's transcript copies them." The `AgentEventRecorder` service JSDoc changes "keeping the transcript cursor of each session it started" to "keeping the transcript cursor of each session it binds".

`catchUpResumed(agentId, sessionId, cwd): Effect<Option<SessionId>>` (module-private; some(sessionId) when caught up, none otherwise), called once by `open` before it returns; `open` assigns the result to `ownedSession`:

1. `info = reader.transcriptInfo(sessionId, cwd)`. None → warning "No transcript to catch up from", none.
2. `cursor = store.readCursor(sessionId)`. Read error → logged, none.
3. `cursor` is some and its `fileSize` and `mtimeMs` equal `info` → some; nothing else is read.
4. `tail = reader.readTranscriptAfter(sessionId, cwd, cursor.lastUuid)` (from the start when there is no cursor; the whole transcript when the cursor uuid is not in it). None → none.
5. `store.appendTranscript(agentId, sessionId, tail)`. Error → logged, none.
6. Log "Caught up from the transcript" with the entry count; some. The cursor holds the tail's size and mtime, never those of step 1, so a change between steps 1 and 4 is read at the next open.

Ownership (replaces #154's `nothingFollowsCursor` and `newConversationPending`): the recorder owns the cursor of the session it last bound. When catch-up of `resume` failed, it owns no session until a `ConversationReset` is bound, because any later session of the agent (a fork, or a `SessionStarted` under another id) can contain entries of the `resume` session that were never stored, and its cursor would move past them. Before the first bind it owns the `resume` session only when catch-up succeeded. Leaving an owned session still queues its last cursor update (`rebind`). A cursor update whose tail has no entries writes the tail's size and mtime under the stored `lastUuid`, because the CLI changes the transcript's mtime when a resumed session starts (`docs/reasoning/2026-11-03-resume-touches-transcript.md`; found during verification).

| Session bound | #154 | This spec |
| --- | --- | --- |
| `resume`, caught up | owned only when nothing followed its cursor | owned |
| `resume`, catch-up failed | not owned | not owned |
| `SessionStarted` under another id, catch-up of `resume` failed | not owned | not owned until a `ConversationReset` |
| first session of a new pane | owned | owned |
| `ConversationReset` and the `SessionStarted` after it | owned | owned |
| rewind fork (`SessionStarted` after a finished turn), no failed catch-up | not owned | owned: its new entries are shown live; unverified: whether the fork's transcript keeps the uuids of the entries it copies |

Unverified: whether a restarted pane's `open` can run while the previous recorder of the same agent still drains cursor updates. Pane start latency for a large first import is not measured. `getSessionInfo`'s `lastModified` is documented as integer milliseconds (`sdk.d.ts`, `SDKSessionInfo`); that it equals the file's stat mtime is unverified and harmless, because the cursor stores the same value it later compares. Unverified: whether a fork's transcript keeps the uuids of the entries it copies; if not, opening a fork whose cursor was withheld imports its copied entries a second time.

## Success criteria → tests

| Criterion | Test |
| --- | --- |
| Turns added outside dia are appended on open, cursor at the last main-chain entry | recorder: resumed, cursor at `a1` with other size, tail `u2,a2` → items gain `u2`,`a2`; cursor `a2` |
| No cursor row → whole transcript imported | recorder: resumed, no cursor, tail `u1,a1` → both items, cursor `a1` |
| Unchanged size and mtime → no read past the info, nothing appended | recorder: `readTranscriptAfter` never called; no events |
| Known source uuids not appended again | store: entries `u1` (already stored under item `live-1`), `a1` → only `a1` appended |
| Every entry known → cursor still moves | store: all entries stored → no events, cursor at the last entry |
| Zero entries | store: with a cursor → size and mtime updated, `lastUuid` unchanged; without → no cursor |
| Batches of 500+, cursor with the last batch | store: 1,200 entries, one event per uuid → 1,200 events, cursor at the last entry; same input with `CREATE TEMP TRIGGER … BEFORE INSERT ON agent_transcript_cursors BEGIN SELECT RAISE(ABORT, 'x'); END` → events 1–1,000 stored, no cursor; same input with `CREATE TEMP TRIGGER … BEFORE INSERT ON agent_events WHEN NEW.source_uuid = 'u600' BEGIN SELECT RAISE(ABORT, 'x'); END` → events 1–500 stored, no cursor |
| A batch never splits one source uuid | store: one uuid holds events 499–502, a temp trigger `WHEN NEW.source_uuid = <uuid of the 600th event>` aborts it, then the trigger is dropped and the call repeated → that uuid has 4 events and every entry is stored once |
| claude-code `transcriptInfo` | transcript.test.ts: `getSessionInfo` undefined, without `fileSize`, or throwing → none with a warning; otherwise `{ fileSize, mtimeMs: lastModified }` |
| `readTranscriptAfter` size source | transcript.test.ts: size and mtime come from `getSessionInfo`, called before `getSessionMessages` |
| Backend contract | agent-backend.test.ts: a backend without `transcriptInfo` is reported `agentBackend.transcriptInfo is not a function`; `unavailableBackend.transcriptInfo` returns none |
| `TranscriptReader.transcriptInfo` | transcript-reader.test.ts: delegates to the backend; none when no adapter is loaded |
| Unchanged file → owned | recorder: size and mtime equal, then turn end → cursor written for the `resume` session |
| Tail unreadable → not owned | recorder: `transcriptInfo` some, `readTranscriptAfter` none → no `writeCursor` at turn end |
| Missing transcript → events and cursor unchanged, warning | recorder: `transcriptInfo` none → no events, no cursor at turn end |
| `readCursor` fails at catch-up → not owned | recorder: `readCursor` fails on its first call only; `readTranscriptAfter` returns entries → no `writeCursor` at turn end |
| `appendTranscript` fails → not owned | recorder: `appendTranscript` fails, `readCursor` and `writeCursor` succeed → no `writeCursor` at turn end |
| A failed catch-up keeps later sessions unowned until a reset | recorder: catch-up fails, `SessionStarted` under another id, turn end → no cursor for either; then `ConversationReset` and a `SessionStarted`, turn end → cursor for the session after the reset |
| Another id after a successful catch-up is owned | recorder: caught up, `SessionStarted` under another id, turn end → cursor for the new id |
| A cursor update with no new entries stores the new size and mtime | recorder: info equals the cursor, tail after `a1` empty with another size and mtime → cursor `a1` with the tail's size and mtime |
| Rewind fork and the session after `/clear` get a cursor at turn end | recorder: flip the three #154 tests "leaves a session that starts after a finished turn to catch-up", "leaves the cursor of a resumed session that has none to catch-up", "leaves the cursor of a resumed session with unread entries to catch-up" |

## Design Rationale

- **Catch-up in `open`** (user decision) — live items must take positions after caught-up ones, so catch-up finishes before the session emits; `open` already runs before `factory.start`.
- **`transcriptInfo`** (user decision) — ADR-0051 compares size and mtime first; without it every pane start parses its transcript.
- **Skip by source uuid in the store** (user decision) — live message item ids are random, so `(agent_id, source_uuid, item_id)` does not match an imported entry for the same message; ADR-0051 says "skipping known source_uuids". The store owns both tables and the transaction, so the recorder does not query `agent_events`.
- **Batches end at a source uuid change** — a retry skips a uuid once any of its events is stored, so one batch holds all events of each uuid.
- **Yield between batches** — `Effect.yieldNow` between transactions lets other Host fibers run; it does not shorten the synchronous `getSessionMessages` parse.
- **One ownership rule** (user decision) — every session the recorder binds is one whose new entries are shown live, or one it caught up; a failed catch-up withholds ownership until a reset, so no cursor moves past entries never stored.
- **`catchUpResumed` as one function** — the recorder's `open` holds no step of it; #157 reuses `appendTranscript`, not `catchUpResumed`.

## Refinement Record

**Applied (round 1)**
- blocker (correctness) — a batch split one source uuid, so a retry after a failed batch skipped its remaining events; batches now end only at a source uuid change.
- major (correctness) — `appendTranscript` JSDoc names both error types.
- major (correctness) — cursor keyed by session: one-agent-per-session assumption stated for #157.
- major (correctness) — a Host kill mid-turn can duplicate streamed text too; the accepted limitation is reworded.
- major (correctness) — zero-entry, all-skipped and cursor-not-found semantics stated, with tests.
- major (project rules) — the three #154 tests that flip and the error-path tests are listed.
- minor — ADR-0032 rule cited correctly; fork uuid preservation marked unverified; JSDoc with no implementation detail and the stale JSDoc to update listed; catch-up is one `catchUp` function.

**Applied (round 2)**
- blocker (correctness) — after a failed catch-up, a later session under another id was owned and its cursor moved past entries never stored; ownership is now withheld until a `ConversationReset`.
- major (correctness) — the duplication left by live events without a source uuid is stated precisely (thinking, mid-stream text; tool calls are not duplicated as items).
- major (correctness) — size and mtime are read before the entries; the cursor stores the tail's, not step 1's.
- major (correctness) — test rows rewritten so each fails when the behaviour is wrong.
- major (project rules) — `appendTranscript` JSDoc states the contract, not the batching.
- major (project rules) — the #154 design, the clear-session-id reasoning entry and ADR-0051 line 70 are updated in this branch.
- minor — `catchUpResumed` returns `Option<SessionId>`.

**Rejected (round 2)**
- "#156 hides `<uuid>:thinking` items when a live reasoning item exists" — prescribes another issue's design; the duplicate is recorded as accepted instead.

**Applied (round 3)**
- major (correctness) — `open`'s JSDoc states what happens to a failed session once the pane persists another id; the fork-uuid gap is stated on that path.
- major (project rules) — tests for `transcriptInfo`, the backend contract and `TranscriptReader`, and the stubs that gain `transcriptInfo`.
- major (correctness) — store test rows use temp triggers keyed on `source_uuid` and exercise different batches.
- major (project rules) — three more doc statements this change makes false are listed.
- minor — `TRANSCRIPT_BATCH_SIZE` JSDoc; `lastModified` integer documented in `sdk.d.ts`.

**Rejected (round 3)**
- "thinking is skipped when it shares the uuid of a stored text event" — each content block is its own JSONL entry with its own uuid (confirmed in #153), so thinking never shares that uuid; the citation is added to the bullet.
