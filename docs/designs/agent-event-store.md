# Agent event store (issue #152)

Scope: module. Spans `src/shared/domain/agent-event.ts` (event and item schemas), `src/host/services/agent-event-store.ts` (append and paged read), `src/host/services/kernel-migrations.ts` (`3_agent_events`), `src/host/services/database.ts` (`synchronous = NORMAL` on `host.db`), `src/host/services/workspace-store.ts` (`agents.archived` → `agents.archived_at`), `src/host/host-main.ts` (layer wiring) and ADR-0051 (reasoning kind, item key, idempotency key, measured commit cost). Implements the "Storage shape" and "Durability" sections of ADR-0051. No caller appends events yet (#154); catch-up (#155), replay (#156), import (#157), the archive flow and compaction (#158) and the tool-output cap are out of scope. `DiaRpcs` does not change, so `PROTOCOL_VERSION` stays.

## Name and Purpose

`AgentEventStore` records each agent's conversation in `host.db` as an append-only event log, keeps a per-item projection of it in the same transaction, and reads that projection one page at a time.

## Interface

### Schemas (`src/shared/domain/agent-event.ts`)

```ts
/** A message in an agent's conversation was created, grew while streaming, or was finalised. `itemId` names the item across its updates. */
export const MessageUpdated = Schema.TaggedStruct('MessageUpdated', {
  itemId: Schema.String,
  message: ConversationMessage,
  streaming: Schema.Boolean
})
/** One span of the agent's extended-thinking text was created, grew, or was finalised. */
export const ReasoningUpdated = Schema.TaggedStruct('ReasoningUpdated', {
  itemId: Schema.String,
  text: Schema.String,
  streaming: Schema.Boolean
})
/** The agent began a tool call. The call's item id is `toolCallId`. */
export const ToolCallStarted = Schema.TaggedStruct('ToolCallStarted', {
  toolCallId: Schema.String,
  toolName: Schema.String
})
/** A tool call finished, with its input, its output flattened to text, and whether it failed. */
export const ToolCallCompleted = Schema.TaggedStruct('ToolCallCompleted', {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  output: Schema.String,
  isError: Schema.Boolean
})
/** The agent's conversation continues in SDK session `sessionId` from this event on (start, `/clear`, compaction, fork). */
export const SessionBound = Schema.TaggedStruct('SessionBound', { sessionId: SessionId })
/** The agent was created from the existing SDK session `sessionId`. */
export const AgentImported = Schema.TaggedStruct('AgentImported', { sessionId: SessionId })
/** The agent was archived. */
export const AgentArchived = Schema.TaggedStruct('AgentArchived', {})
/** The agent was unarchived. */
export const AgentUnarchived = Schema.TaggedStruct('AgentUnarchived', {})

/** Every event an agent's stream holds. Match on `_tag`. */
export const AgentEvent = Schema.Union([MessageUpdated, ReasoningUpdated, ToolCallStarted,
  ToolCallCompleted, SessionBound, AgentImported, AgentArchived, AgentUnarchived])
/** An event of an agent's stream; see {@link AgentEvent}. */
export type AgentEvent = typeof AgentEvent.Type

/** A message of an agent's conversation at `position`; `streaming` until its final update. */
export const MessageItem = Schema.TaggedStruct('MessageItem', {
  itemId: Schema.String, position: Schema.Int, streaming: Schema.Boolean, message: ConversationMessage
})
/** A span of extended-thinking text at `position`; `streaming` until its final update. */
export const ReasoningItem = Schema.TaggedStruct('ReasoningItem', {
  itemId: Schema.String, position: Schema.Int, streaming: Schema.Boolean, text: Schema.String
})
/** A tool call at `position`: `running` until its `ToolCallCompleted`, after which `input`, `output` and `isError` are present. */
export const ToolCallItem = Schema.TaggedStruct('ToolCallItem', {
  itemId: Schema.String, position: Schema.Int, running: Schema.Boolean, toolName: Schema.String,
  input: Schema.optional(JsonRecord), output: Schema.optional(Schema.String), isError: Schema.optional(Schema.Boolean)
})
/** One rendered item of an agent's conversation. Items are ordered by `position` (0-based, the arrival order of each item's first event). Match on `_tag`. */
export const AgentItem = Schema.Union([MessageItem, ReasoningItem, ToolCallItem])
/** An item of an agent's conversation; see {@link AgentItem}. */
export type AgentItem = typeof AgentItem.Type
```

`JsonRecord` comes from `src/shared/domain/json-record.ts`; `ConversationMessage` and `SessionId` from `src/shared/domain/pane.ts`.

### Service (`src/host/services/agent-event-store.ts`)

```ts
/** `append` stored nothing from its batch; carries the `SqlError`. */
export class AgentEventWriteError extends Data.TaggedError('AgentEventWriteError')<{ readonly cause: unknown }> {}
/** `readItems` could not read `host.db`; carries the `SqlError`. */
export class AgentEventReadError extends Data.TaggedError('AgentEventReadError')<{ readonly cause: unknown }> {}

/** Service tag for the Host's per-agent event log and its item projection. Provide it with {@link AgentEventStoreLive}. */
export class AgentEventStore extends Context.Service<AgentEventStore, {
  /**
   * Appends `events` to agent `agentId`'s stream in order, in one transaction, and updates the
   * agent's items to match. `sourceUuid` is the SDK message uuid an event came from; an event whose
   * `sourceUuid` and item are already stored is skipped. Returns one entry per input event:
   * `Some(sequence)` when appended, `None` when skipped. Sequences increase but are not contiguous.
   * Fails with AgentEventWriteError, and then nothing from the batch is stored.
   */
  readonly append: (
    agentId: string,
    events: ReadonlyArray<{ readonly event: AgentEvent; readonly sourceUuid?: string }>
  ) => Effect.Effect<ReadonlyArray<Option.Option<number>>, AgentEventWriteError>
  /**
   * Up to `limit` items of agent `agentId` whose position is above `afterPosition` (from the
   * first item when absent), in position order. A stored item that does not decode is left out
   * and logged.
   */
  readonly readItems: (
    agentId: string,
    page: { readonly afterPosition?: number; readonly limit: number }
  ) => Effect.Effect<ReadonlyArray<AgentItem>, AgentEventReadError>
}>()('AgentEventStore') {}

/** Provides {@link AgentEventStore} over the Host's `SqlClient` from `makeHostDatabaseLive`. */
export const AgentEventStoreLive: Layer.Layer<AgentEventStore, never, SqlClient.SqlClient>
```

### Projection rules (inside `append`)

Each event is inserted with `INSERT … ON CONFLICT DO NOTHING RETURNING sequence`; an empty result means skipped, and a skipped event changes no item.

| Event | `agent_events.item_id` | `agent_items` effect |
| --- | --- | --- |
| `MessageUpdated` | `itemId` | upsert `kind = 'message'`, `streaming`, payload `{ message }` |
| `ReasoningUpdated` | `itemId` | upsert `kind = 'reasoning'`, `streaming`, payload `{ text }` |
| `ToolCallStarted` | `toolCallId` | insert `kind = 'tool_call'`, `streaming = 1`, payload `{ toolName }`; an existing row is unchanged |
| `ToolCallCompleted` | `toolCallId` | upsert `kind = 'tool_call'`, `streaming = 0`, payload `{ toolName, input, output, isError }` |
| `SessionBound`, `AgentImported` | null | none |
| `AgentArchived` | null | `UPDATE agents SET archived_at = ? WHERE agent_id = ?`, bound to the call's `occurred_at` |
| `AgentUnarchived` | null | `UPDATE agents SET archived_at = NULL WHERE agent_id = ?` |

A new item's position is `SELECT COALESCE(MAX(position), -1) + 1 FROM agent_items WHERE agent_id = ?`, read inside the transaction. An upsert of an existing item (`ON CONFLICT (agent_id, item_id) DO UPDATE`) keeps its position. `occurred_at` is `Clock.currentTimeMillis` read once per `append` call.

### Migration `3_agent_events` (`kernel-migrations.ts`)

An `Effect.gen` of its own (not a `runEach` list), because it binds the migration time:

```sql
CREATE TABLE agent_events (
  sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT    NOT NULL,
  event_type   TEXT    NOT NULL,
  item_id      TEXT,
  source_uuid  TEXT,
  occurred_at  INTEGER NOT NULL,
  payload_json TEXT    NOT NULL
);
CREATE UNIQUE INDEX agent_events_source ON agent_events (agent_id, source_uuid, COALESCE(item_id, '')) WHERE source_uuid IS NOT NULL;
CREATE INDEX agent_events_by_agent ON agent_events (agent_id, sequence);
CREATE TABLE agent_items (
  agent_id     TEXT    NOT NULL,
  item_id      TEXT    NOT NULL,
  position     INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('message', 'reasoning', 'tool_call')),
  streaming    INTEGER NOT NULL CHECK (streaming IN (0, 1)),
  payload_json TEXT    NOT NULL,
  PRIMARY KEY (agent_id, item_id)
);
CREATE UNIQUE INDEX agent_items_by_position ON agent_items (agent_id, position);
CREATE TABLE agent_transcript_cursors (
  session_id TEXT    PRIMARY KEY,
  last_uuid  TEXT    NOT NULL,
  file_size  INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL
);
ALTER TABLE agents ADD COLUMN archived_at INTEGER;
-- then: const now = yield* Clock.currentTimeMillis; sql.unsafe('UPDATE agents SET archived_at = ? WHERE archived = 1', [now])
ALTER TABLE agents DROP COLUMN archived;
```

Checked on `node:sqlite` 3.53.4: `DROP COLUMN` succeeds on `archived`, whose `CHECK` is its own; the expression unique index with `ON CONFLICT DO NOTHING RETURNING` returns no row for a repeat of `(source_uuid, item_id)` and for a repeat of `(source_uuid, NULL)`, never rejects rows without `source_uuid`, and a skipped insert still consumes a sequence number. The migrator runs all pending migrations in one transaction (`effect/src/sql/Migrator.ts:328-331`).

There are no foreign keys from the event tables to `agents`: #157 appends `AgentImported` before the debounced workspace save writes the `agents` row. #158's delete removes the rows explicitly.

### `host.db` durability (`database.ts`)

```ts
export const makeHostDatabaseLive = (userDataPath: string) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.tap(openDatabase(`${userDataPath}/host.db`, kernelMigrations), (sql) =>
      sql.unsafe('PRAGMA synchronous = NORMAL'))
  )
```

The pragma runs after the migrations commit. `synchronous` is per connection, and `SqliteClient` holds one connection behind a one-permit semaphore (`SqliteClient.ts:148`, `:345`). WAL is already its default (`SqliteClient.ts:172-179`). Plugin databases keep `FULL`.

### `WorkspaceStore`

`Tab.archived` stays a boolean. Read: `a.archived_at IS NOT NULL AS archived`. Write: `archived_at` = the save's `now` when `tab.archived`, else null, with `ON CONFLICT … archived_at = CASE WHEN excluded.archived_at IS NULL THEN NULL ELSE COALESCE(agents.archived_at, excluded.archived_at) END`, so a re-save keeps the earlier archive time, including one an `AgentArchived` event set. The raw `INSERT INTO agents` in `workspace-store.test.ts`'s `storeWithUnreadableProject` (`:494`) drops `archived: 0`; `archived_at` defaults to null.

### Logging

`append` logs at debug `Appended agent events` with `agentId`, `events`, `appended`, `skipped`. Both methods log at error `Could not append agent events` / `Could not read agent items` with `agentId` and the cause where they map `SqlError` to their error. `readItems` logs at warning `Left out an agent item that does not decode` with `agentId`, `itemId` and the decode message.

## Key Data Structures

- `agent_items.payload_json` holds an item's fields other than `itemId`, `position`, `kind` and `streaming`; `readItems` rebuilds an `AgentItem` from the columns plus the payload. `kind` selects the member; for `tool_call`, `streaming` becomes `running`.
- `agent_events.payload_json` holds the encoded `AgentEvent`, with `_tag`; `event_type` repeats `_tag` for queries.

## Design Rationale

**Batch `append`** — one transaction per call: import (#157) passes 500 events per call, a live flush (#154) passes the events of one 50 ms window. One method serves both.

**`Option` per input event** — #156 uses `agent_events.sequence` as `PaneEventFrame.seq`, so a writer needs the sequence each event got, matched to its input.

**Idempotency key `(agent_id, source_uuid, item_id)`** — an import of a forked session repeats the source session's uuids under another agent, so the key includes `agent_id`. One SDK transcript entry yields several events: a user entry holds the `tool_result` of every parallel tool call, each a `ToolCallCompleted` with its own `toolCallId`. A key of `source_uuid` alone would keep only the first. Amends ADR-0051's "`source_uuid` UNIQUE where not null". A streaming `MessageUpdated` that has no SDK uuid yet is written with no `sourceUuid`.

**Item key `(agent_id, item_id)`** — item ids come from SDK ids, and one session's ids can reach two agents (an import of a session forked from another agent's). Keying by agent keeps one agent's upsert from moving another's row. Amends ADR-0051's "`item_id` primary key".

**Separate `reasoning` kind** — thinking text is its own item, as in T3 Code (`orchestrationV2.ts:1366-1371`), so `ConversationMessage` stays the provider-neutral message shape. Amends ADR-0051's kind list and its Content table.

**Projection keyed by item, not message part** — tool calls are their own items, as T3 Code's `dynamic_tool` turn items are, so a tool call's completion updates one row instead of rewriting its message.

**The store writes `agents.archived_at`** — ADR-0051 requires the archive event and the column to commit in one transaction, and only the store's transaction holds the event. `WorkspaceStore` is the only other writer, and its `COALESCE` keeps a time the event set.

## Rejected Alternatives

**`PaneMessage` as the message payload** — ties the store to the renderer's view model and stores tool calls twice.

**Foreign keys to `agents`** — see the migration note.

**`synchronous = NORMAL` for every database** — #152 scopes it to `host.db`; no plugin owner asked for it.

**Schemas for `append`'s input and `readItems`' page** — the "derive types from schemas" rule forbids a hand-declared type beside a parallel schema. These parameters cross no process boundary and are never decoded, so no schema exists to derive from.

## Tests

- `database.test.ts`: a fresh `host.db` and one at migration 2 holding an archived and an active agent both apply `3_agent_events`; the new tables and indexes exist; the archived agent's `archived_at` is the `TestClock` time and the active one's is null; `PRAGMA journal_mode` is `wal` and `PRAGMA synchronous` is 1.
- `workspace-store.test.ts`: an archived tab round-trips as archived; a second save keeps the first `archived_at`; a save of the tab with `archived` true after an `AgentArchived` keeps the event's `archived_at`.
- `agent-event-store.test.ts`: two `MessageUpdated` for one item give one row with the first position and the latest payload; a repeated `(sourceUuid, item)` returns `None`, stores no event and leaves the item unchanged; two `ToolCallCompleted` with one `sourceUuid` and different `toolCallId`s are both stored; the same `itemId` in two agents gives two items; the same `(sourceUuid, item)` in a second agent is stored; a failing projection write (the `agent_items` table dropped) stores no event; `readItems` returns pages in position order and leaves out an undecodable row; `AgentArchived` sets and `AgentUnarchived` clears `archived_at`; `ToolCallStarted` then `ToolCallCompleted` give one item with `running` false.

## Refinement Record

**Round 1**

*Applied*
- *Correctness* — `:now` in a `runEach` statement is never bound (`kernel-migrations.ts:7`, `Statement.ts:491-494`); the migration is now its own `Effect.gen` reading `Clock`.
- *Correctness* — the pragma's placement was unstated; it now runs in `Effect.tap` after `openDatabase` returns.
- *Correctness* — `item_id` alone as `agent_items` key let two agents' items collide; key is `(agent_id, item_id)`.
- *Define Errors Out of Existence* — `ReadonlyArray<number>` could not be matched to inputs once events were skipped; now one `Option` per input.
- *Correctness* — `source_uuid` alone as the idempotency key dropped later events of one SDK entry; the key is `(source_uuid, item_id)` (extended beyond the finding to the parallel `tool_result` case).
- *Project rules* — JSDoc on every export; error-level logging where errors are mapped; event count in the debug log.
- *Information Hiding* — the second writer of `archived_at` is now justified in the rationale and covered by a test.
- *Minor* — `running` mapping stated; position formula stated; tests for the new cases added; `PROTOCOL_VERSION` noted.

*Rejected*
- *Project rules* — `AgentEventInput` and the `readItems` page as schemas. The rule forbids a hand-declared type beside a parallel schema; neither has a schema or is decoded. The named `AgentEventInput` interface was removed in favour of an inline parameter type.

**Round 2**

*Applied*
- *Correctness* — `occurred_at` is not a column of `agents`; the archive update binds the call's `occurred_at` as a parameter.
- *Correctness* — `storeWithUnreadableProject`'s raw insert (`workspace-store.test.ts:494`) writes the dropped `archived` column; the spec now names it.
- *Minor* — the save-after-archive test states the tab is saved with `archived` true.

Round 2 left no blocker or major finding; rounds stopped early (budget 3).
