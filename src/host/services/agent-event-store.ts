import { AgentEvent, AgentItem } from '@shared/domain/agent-event'
import { SessionId } from '@shared/domain/pane'
import { PaneSignal } from '@shared/ipc/contract'
import {
  Array as Arr,
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  PubSub,
  Result,
  Schema,
  Semaphore,
  Stream
} from 'effect'
import { SqlClient } from 'effect/sql'
import type { TranscriptEntry, TranscriptTail } from '../session/agent-backend'

/**
 * Any event an agent's stream stores: a conversation {@link AgentEvent}, which also updates the
 * agent's items, or a {@link PaneSignal} about the agent's pane, which is stored and replayed only.
 */
export const StoredEvent = Schema.Union([AgentEvent, PaneSignal])
/** A stored event; see {@link StoredEvent}. */
export type StoredEvent = typeof StoredEvent.Type

/** An event to append, with the SDK message uuid it came from when it came from one. */
export interface AppendEntry {
  readonly event: StoredEvent
  readonly sourceUuid?: string
}

/** A stored event of agent `agentId` with the `sequence` its row was committed under. */
export const CommittedEvent = Schema.Struct({
  agentId: Schema.String,
  sequence: Schema.Int,
  event: StoredEvent
})
/** A committed event; see {@link CommittedEvent}. */
export type CommittedEvent = typeof CommittedEvent.Type

/**
 * The events of an agent after a cursor, in sequence order, and `through`: the agent's highest
 * sequence when they were read. Every event of the agent up to `through` is in `events` or at or
 * before the cursor.
 */
export const Replay = Schema.TaggedStruct('Replay', {
  events: Schema.Array(CommittedEvent),
  through: Schema.Int
})
/** A replay; see {@link Replay}. */
export type Replay = typeof Replay.Type

/**
 * The events after a cursor cannot be replayed, so the reader must start from the agent's history:
 * the cursor is past the agent's last event (`ahead`), there are more events or bytes than the
 * limits allow (`tooLarge`), one of them does not decode (`undecodable`), or `host.db` could not be
 * read (`readFailed`).
 */
export const ReloadRequired = Schema.TaggedStruct('ReloadRequired', {
  reason: Schema.Literals(['ahead', 'tooLarge', 'undecodable', 'readFailed'])
})
/** A reload requirement; see {@link ReloadRequired}. */
export type ReloadRequired = typeof ReloadRequired.Type

/** How many events (`maxEvents`) and payload bytes (`maxBytes`) one replay may hold. */
export interface ReplayLimits {
  readonly maxEvents: number
  readonly maxBytes: number
}

/**
 * A write to `host.db` failed; the failing method's documentation states what stays stored.
 * Carries the `SqlError`.
 */
export class AgentEventWriteError extends Data.TaggedError('AgentEventWriteError')<{
  readonly cause: unknown
}> {}

/** A read of `host.db` failed. Carries the `SqlError`. */
export class AgentEventReadError extends Data.TaggedError('AgentEventReadError')<{
  readonly cause: unknown
}> {}

/**
 * Where catch-up resumes reading SDK session `sessionId`'s transcript: after entry `lastUuid`,
 * when the file's size (`fileSize`, bytes) or modification time (`mtimeMs`, epoch ms) differs.
 */
export const TranscriptCursor = Schema.Struct({
  sessionId: SessionId,
  lastUuid: Schema.String,
  fileSize: Schema.Int,
  mtimeMs: Schema.Int
})
/** A transcript cursor; see {@link TranscriptCursor}. */
export type TranscriptCursor = typeof TranscriptCursor.Type

/**
 * The least number of events one `appendTranscript` write commits together. A call that fails
 * keeps the writes committed before the failure.
 */
export const TRANSCRIPT_BATCH_SIZE = 500

/** Service tag for the Host's per-agent event log and its item projection in `host.db`. Provide it with {@link AgentEventStoreLive}. */
export class AgentEventStore extends Context.Service<
  AgentEventStore,
  {
    /**
     * Appends `events` to agent `agentId`'s stream in order, in one transaction, and updates the
     * agent's items to match its {@link AgentEvent}s. `sourceUuid` is the SDK message uuid an event
     * came from; an event whose `sourceUuid` and item are already stored is skipped. Returns one
     * entry per input event: `Some(sequence)` when appended, `None` when skipped. Sequences
     * increase but are not contiguous. Every appended event is offered to `committed` once the
     * transaction commits. Fails with {@link AgentEventWriteError}, and then nothing from the batch
     * is stored or offered.
     */
    readonly append: (
      agentId: string,
      events: ReadonlyArray<AppendEntry>
    ) => Effect.Effect<ReadonlyArray<Option.Option<number>>, AgentEventWriteError>
    /**
     * Appends to agent `agentId` the entries of `tail`, read from SDK session `sessionId`'s
     * transcript, skipping each entry whose `sourceUuid` the agent already has an event for, then
     * stores the session's cursor at the tail's last entry (skipped or not) with the tail's size
     * and mtime. All events of one source uuid are stored together or not at all. A tail with no
     * entries updates only the size and mtime of an existing cursor, and stores nothing when none
     * exists. Fails with {@link AgentEventReadError} when the stored source uuids cannot be read,
     * and with {@link AgentEventWriteError} when a write fails; the entries stored before the
     * failure stay, the cursor is unchanged, and calling again with the same tail stores the rest.
     * Each committed batch is offered to `committed`.
     */
    readonly appendTranscript: (
      agentId: string,
      sessionId: SessionId,
      tail: TranscriptTail
    ) => Effect.Effect<void, AgentEventWriteError | AgentEventReadError>
    /**
     * Every event committed from now on, by any agent, in commit order (which is sequence order).
     * Each subscriber receives the events committed after it subscribed; events are never
     * dropped, and the store never waits for a subscriber.
     */
    readonly committed: Stream.Stream<CommittedEvent>
    /**
     * The events of agent `agentId` after sequence `afterSequence`, read in one transaction: a
     * {@link Replay}, or {@link ReloadRequired} when they cannot be replayed within `limits` (the
     * byte limit counts each event's stored JSON in UTF-8). Never fails; a failed read is logged
     * and returned as `readFailed`.
     */
    readonly readAfter: (
      agentId: string,
      afterSequence: number,
      limits: ReplayLimits
    ) => Effect.Effect<Replay | ReloadRequired>
    /**
     * All items of agent `agentId` in position order, and `through`: the agent's highest sequence
     * (0 when it has none) when they were read, in one transaction. The items are the agent's
     * conversation after every event up to `through`. A stored item that does not decode is left
     * out and logged. Fails with {@link AgentEventReadError} when `host.db` cannot be read.
     */
    readonly readHistory: (
      agentId: string
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<AgentItem>; readonly through: number },
      AgentEventReadError
    >
    /**
     * The highest sequence of agent `agentId`, or 0 when it has none. Fails with
     * {@link AgentEventReadError} when `host.db` cannot be read.
     */
    readonly lastSequence: (agentId: string) => Effect.Effect<number, AgentEventReadError>
    /**
     * The highest sequence of any agent, or 0 when none has an event. Fails with
     * {@link AgentEventReadError} when `host.db` cannot be read.
     */
    readonly highestSequence: Effect.Effect<number, AgentEventReadError>
    /**
     * The stored cursor of SDK session `sessionId`, or none when there is none. Fails with
     * {@link AgentEventReadError} when `host.db` cannot be read.
     */
    readonly readCursor: (
      sessionId: SessionId
    ) => Effect.Effect<Option.Option<TranscriptCursor>, AgentEventReadError>
    /**
     * Stores `cursor` as its session's cursor, replacing any earlier one. Fails with
     * {@link AgentEventWriteError}, and then the earlier cursor stays.
     */
    readonly writeCursor: (cursor: TranscriptCursor) => Effect.Effect<void, AgentEventWriteError>
  }
>()('AgentEventStore') {}

type ItemKind = 'message' | 'reasoning' | 'tool_call'

interface ItemRow {
  readonly item_id: string
  readonly position: number
  readonly kind: ItemKind
  readonly streaming: number
  readonly payload_json: string
}

const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(StoredEvent))
const decodeEventJson = Schema.decodeUnknownResult(Schema.fromJsonString(StoredEvent))
const decodePayload = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeItem = Schema.decodeUnknownResult(AgentItem)

interface ItemWrite {
  readonly itemId: string
  readonly kind: ItemKind
  readonly streaming: boolean
  readonly payload: object
  readonly keepExisting: boolean
}

const itemWriteOf = (event: StoredEvent): ItemWrite | null => {
  switch (event._tag) {
    case 'MessageUpdated':
      return {
        itemId: event.itemId,
        kind: 'message',
        streaming: event.streaming,
        payload: { message: event.message },
        keepExisting: false
      }
    case 'ReasoningUpdated':
      return {
        itemId: event.itemId,
        kind: 'reasoning',
        streaming: event.streaming,
        payload: { text: event.text },
        keepExisting: false
      }
    case 'ToolCallStarted':
      return {
        itemId: event.toolCallId,
        kind: 'tool_call',
        streaming: true,
        payload: { toolName: event.toolName },
        keepExisting: true
      }
    case 'ToolCallCompleted':
      return {
        itemId: event.toolCallId,
        kind: 'tool_call',
        streaming: false,
        payload: {
          toolName: event.toolName,
          input: event.input,
          output: event.output,
          isError: event.isError
        },
        keepExisting: false
      }
    default:
      return null
  }
}

const itemFromRow = (row: ItemRow) => {
  const payload = decodePayload(row.payload_json)
  if (Result.isFailure(payload)) return payload
  const streaming = row.streaming === 1
  const common = { itemId: row.item_id, position: row.position }
  const fields = payload.success as object
  switch (row.kind) {
    case 'message':
      return decodeItem({ _tag: 'MessageItem', ...fields, ...common, streaming })
    case 'reasoning':
      return decodeItem({ _tag: 'ReasoningItem', ...fields, ...common, streaming })
    case 'tool_call':
      return decodeItem({ _tag: 'ToolCallItem', ...fields, ...common, running: streaming })
  }
}

const batchesOf = (
  entries: ReadonlyArray<TranscriptEntry>
): ReadonlyArray<ReadonlyArray<TranscriptEntry>> => {
  const batches: Array<ReadonlyArray<TranscriptEntry>> = []
  let current: Array<TranscriptEntry> = []
  let currentUuid: string | undefined
  for (const entry of entries) {
    if (current.length >= TRANSCRIPT_BATCH_SIZE && entry.sourceUuid !== currentUuid) {
      batches.push(current)
      current = []
    }
    current.push(entry)
    currentUuid = entry.sourceUuid
  }
  batches.push(current)
  return batches
}

const pruneOrphans = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const orphaned = yield* sql.withTransaction(
    Effect.gen(function* () {
      const events = yield* sql<{ readonly sequence: number }>`DELETE FROM agent_events
        WHERE agent_id NOT IN (SELECT agent_id FROM agents) RETURNING sequence`
      yield* sql`DELETE FROM agent_items WHERE agent_id NOT IN (SELECT agent_id FROM agents)`
      return events.length
    })
  )
  if (orphaned > 0) {
    yield* Effect.logInfo('Deleted the events of panes that never became agents', {
      events: orphaned
    })
  }
}).pipe(
  Effect.catch((cause) => Effect.logError('Could not delete orphaned agent events', { cause }))
)

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const writes = yield* Semaphore.make(1)
  const committedEvents = yield* PubSub.unbounded<CommittedEvent>()
  yield* pruneOrphans

  const writeItem = (agentId: string, item: ItemWrite) =>
    sql`INSERT INTO agent_items (agent_id, item_id, position, kind, streaming, payload_json)
      VALUES (${agentId}, ${item.itemId},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM agent_items WHERE agent_id = ${agentId}),
        ${item.kind}, ${item.streaming ? 1 : 0}, ${JSON.stringify(item.payload)})
      ON CONFLICT (agent_id, item_id) ${sql.literal(
        item.keepExisting
          ? 'DO NOTHING'
          : 'DO UPDATE SET kind = excluded.kind, streaming = excluded.streaming, payload_json = excluded.payload_json'
      )}`

  const project = (
    agentId: string,
    event: StoredEvent,
    item: ItemWrite | null,
    occurredAt: number
  ) => {
    if (item !== null) return writeItem(agentId, item)
    switch (event._tag) {
      case 'AgentArchived':
        return sql`UPDATE agents SET archived_at = ${occurredAt} WHERE agent_id = ${agentId}`
      case 'AgentUnarchived':
        return sql`UPDATE agents SET archived_at = NULL WHERE agent_id = ${agentId}`
      case 'ConversationCleared':
        return sql`DELETE FROM agent_items WHERE agent_id = ${agentId}`
      case 'ConversationRewound':
        return sql`DELETE FROM agent_items WHERE agent_id = ${agentId} AND position >= (
          SELECT position FROM agent_items WHERE agent_id = ${agentId} AND kind = 'message'
            AND json_extract(payload_json, '$.message.checkpointUuid') = ${event.checkpointUuid})`
      default:
        return Effect.void
    }
  }

  const appendOne = Effect.fnUntraced(function* (
    agentId: string,
    input: AppendEntry,
    occurredAt: number
  ) {
    const item = itemWriteOf(input.event)
    const inserted = yield* sql<{
      readonly sequence: number
    }>`INSERT INTO agent_events ${sql.insert({
      agent_id: agentId,
      event_type: input.event._tag,
      item_id: item?.itemId ?? null,
      source_uuid: input.sourceUuid ?? null,
      occurred_at: occurredAt,
      payload_json: encodeEventJson(input.event)
    })} ON CONFLICT DO NOTHING RETURNING sequence`
    if (inserted.length === 0) return Option.none<number>()
    yield* project(agentId, input.event, item, occurredAt)
    return Option.some(inserted[0].sequence)
  })

  const commit = <E>(
    agentId: string,
    entries: ReadonlyArray<AppendEntry>,
    occurredAt: number,
    alsoWrite: Effect.Effect<void, E>
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const sequences = yield* sql.withTransaction(
          Effect.forEach(entries, (input) => appendOne(agentId, input, occurredAt)).pipe(
            Effect.tap(() => alsoWrite)
          )
        )
        yield* PubSub.publishAll(
          committedEvents,
          entries.flatMap((entry, index) =>
            Option.match(sequences[index] ?? Option.none(), {
              onNone: () => [],
              onSome: (sequence) => [CommittedEvent.make({ agentId, sequence, event: entry.event })]
            })
          )
        )
        return sequences
      })
    )

  const append = Effect.fn('AgentEventStore.append')(
    function* (agentId: string, events: ReadonlyArray<AppendEntry>) {
      const occurredAt = yield* Clock.currentTimeMillis
      const sequences = yield* commit(agentId, events, occurredAt, Effect.void)
      const appended = sequences.filter(Option.isSome).length
      yield* Effect.logDebug('Appended agent events', {
        agentId,
        events: events.length,
        appended,
        skipped: events.length - appended
      })
      return sequences
    },
    (effect, agentId) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logError('Could not append agent events', { agentId, cause })
        ),
        Effect.mapError((cause) => new AgentEventWriteError({ cause }))
      )
  )

  const upsertCursor = (cursor: TranscriptCursor) =>
    sql`INSERT INTO agent_transcript_cursors ${sql.insert({
      session_id: cursor.sessionId,
      last_uuid: cursor.lastUuid,
      file_size: cursor.fileSize,
      mtime_ms: cursor.mtimeMs
    })} ON CONFLICT (session_id) DO UPDATE SET last_uuid = excluded.last_uuid,
      file_size = excluded.file_size, mtime_ms = excluded.mtime_ms`

  const storedSourceUuids = (agentId: string, entries: ReadonlyArray<TranscriptEntry>) =>
    sql<{ readonly source_uuid: string }>`SELECT DISTINCT source_uuid FROM agent_events
      WHERE agent_id = ${agentId} AND source_uuid IN (SELECT value FROM json_each(${JSON.stringify(
        entries.map((entry) => entry.sourceUuid)
      )}))`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.source_uuid))),
      Effect.tapError((cause) =>
        Effect.logError('Could not read stored source uuids', { agentId, cause })
      ),
      Effect.mapError((cause) => new AgentEventReadError({ cause }))
    )

  const asTranscriptWrite =
    (agentId: string, sessionId: SessionId) =>
    <A, E, R>(write: Effect.Effect<A, E, R>) =>
      write.pipe(
        Effect.tapError((cause) =>
          Effect.logError('Could not append transcript entries', { agentId, sessionId, cause })
        ),
        Effect.mapError((cause) => new AgentEventWriteError({ cause }))
      )

  const appendTranscript = Effect.fn('AgentEventStore.appendTranscript')(function* (
    agentId: string,
    sessionId: SessionId,
    tail: TranscriptTail
  ) {
    const lastEntry = Arr.last(tail.entries)
    if (Option.isNone(lastEntry)) {
      yield* asTranscriptWrite(
        agentId,
        sessionId
      )(sql`UPDATE agent_transcript_cursors SET file_size = ${tail.fileSize},
        mtime_ms = ${tail.mtimeMs} WHERE session_id = ${sessionId}`)
      yield* Effect.logDebug('Refreshed a transcript cursor for a tail with no entries', {
        sessionId,
        fileSize: tail.fileSize,
        mtimeMs: tail.mtimeMs
      })
      return
    }
    const known = yield* storedSourceUuids(agentId, tail.entries)
    const fresh = tail.entries.filter((entry) => !known.has(entry.sourceUuid))
    const batches = batchesOf(fresh)
    const cursor = TranscriptCursor.make({
      sessionId,
      lastUuid: lastEntry.value.sourceUuid,
      fileSize: tail.fileSize,
      mtimeMs: tail.mtimeMs
    })
    const occurredAt = yield* Clock.currentTimeMillis
    for (const [index, batch] of batches.entries()) {
      if (index > 0) yield* Effect.yieldNow
      const isLast = index === batches.length - 1
      yield* asTranscriptWrite(
        agentId,
        sessionId
      )(
        commit(
          agentId,
          batch,
          occurredAt,
          isLast ? Effect.asVoid(upsertCursor(cursor)) : Effect.void
        )
      )
    }
    yield* Effect.logDebug('Appended transcript entries', {
      agentId,
      sessionId,
      entries: tail.entries.length,
      appended: fresh.length,
      skipped: tail.entries.length - fresh.length,
      batches: batches.length,
      lastUuid: cursor.lastUuid
    })
  })

  const asRead =
    (message: string, context: object) =>
    <A, E, R>(read: Effect.Effect<A, E, R>) =>
      read.pipe(
        Effect.tapError((cause) => Effect.logError(message, { ...context, cause })),
        Effect.mapError((cause) => new AgentEventReadError({ cause }))
      )

  const maxSequenceOf = (agentId: string) =>
    Effect.map(
      sql<{ readonly through: number }>`SELECT COALESCE(MAX(sequence), 0) AS through
        FROM agent_events WHERE agent_id = ${agentId}`,
      (rows) => rows[0]?.through ?? 0
    )

  const readHistory = Effect.fn('AgentEventStore.readHistory')(function* (agentId: string) {
    const { rows, through } = yield* asRead('Could not read agent history', { agentId })(
      sql.withTransaction(
        Effect.all({
          rows: sql<ItemRow>`SELECT item_id, position, kind, streaming, payload_json
            FROM agent_items WHERE agent_id = ${agentId} ORDER BY position`,
          through: maxSequenceOf(agentId)
        })
      )
    )
    const items: Array<AgentItem> = []
    for (const row of rows) {
      const item = itemFromRow(row)
      if (Result.isSuccess(item)) {
        items.push(item.success)
        continue
      }
      yield* Effect.logWarning('Left out an agent item that does not decode', {
        agentId,
        itemId: row.item_id,
        reason: item.failure.message
      })
    }
    yield* Effect.logDebug('Read agent history', { agentId, items: items.length, through })
    return { items, through }
  })

  const readRange = (agentId: string, afterSequence: number, limits: ReplayLimits) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const through = yield* maxSequenceOf(agentId)
        if (afterSequence > through) return ReloadRequired.make({ reason: 'ahead' })
        const [counted] = yield* sql<{ readonly events: number }>`SELECT COUNT(*) AS events
          FROM agent_events WHERE agent_id = ${agentId}
            AND sequence > ${afterSequence} AND sequence <= ${through}`
        if ((counted?.events ?? 0) > limits.maxEvents) {
          return ReloadRequired.make({ reason: 'tooLarge' })
        }
        const [sized] = yield* sql<{ readonly bytes: number }>`SELECT
            COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS bytes
          FROM agent_events WHERE agent_id = ${agentId}
            AND sequence > ${afterSequence} AND sequence <= ${through}`
        if ((sized?.bytes ?? 0) > limits.maxBytes) {
          return ReloadRequired.make({ reason: 'tooLarge' })
        }
        const rows = yield* sql<{
          readonly sequence: number
          readonly payload_json: string
        }>`SELECT sequence, payload_json FROM agent_events WHERE agent_id = ${agentId}
          AND sequence > ${afterSequence} AND sequence <= ${through} ORDER BY sequence`
        const events: Array<CommittedEvent> = []
        for (const row of rows) {
          const event = decodeEventJson(row.payload_json)
          if (Result.isFailure(event)) {
            yield* Effect.logWarning('A stored agent event does not decode', {
              agentId,
              sequence: row.sequence,
              reason: event.failure.message
            })
            return ReloadRequired.make({ reason: 'undecodable' })
          }
          events.push(
            CommittedEvent.make({ agentId, sequence: row.sequence, event: event.success })
          )
        }
        return Replay.make({ events, through })
      })
    )

  const readAfter = Effect.fn('AgentEventStore.readAfter')(function* (
    agentId: string,
    afterSequence: number,
    limits: ReplayLimits
  ) {
    return yield* readRange(agentId, afterSequence, limits).pipe(
      Effect.catch((cause) =>
        Effect.logError('Could not read agent events to replay', {
          agentId,
          afterSequence,
          cause
        }).pipe(Effect.as(ReloadRequired.make({ reason: 'readFailed' })))
      )
    )
  })

  const lastSequence = (agentId: string) =>
    asRead('Could not read the last agent event sequence', { agentId })(maxSequenceOf(agentId))

  const highestSequence = asRead(
    'Could not read the highest agent event sequence',
    {}
  )(
    Effect.map(
      sql<{ readonly through: number }>`SELECT COALESCE(MAX(sequence), 0) AS through
        FROM agent_events`,
      (rows) => rows[0]?.through ?? 0
    )
  )

  const readCursor = Effect.fn('AgentEventStore.readCursor')(
    function* (sessionId: SessionId) {
      const rows = yield* sql<{
        readonly last_uuid: string
        readonly file_size: number
        readonly mtime_ms: number
      }>`SELECT last_uuid, file_size, mtime_ms FROM agent_transcript_cursors
        WHERE session_id = ${sessionId}`
      return Option.map(Option.fromNullishOr(rows[0]), (row) =>
        TranscriptCursor.make({
          sessionId,
          lastUuid: row.last_uuid,
          fileSize: row.file_size,
          mtimeMs: row.mtime_ms
        })
      )
    },
    (effect, sessionId) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logError('Could not read a transcript cursor', { sessionId, cause })
        ),
        Effect.mapError((cause) => new AgentEventReadError({ cause }))
      )
  )

  const writeCursor = Effect.fn('AgentEventStore.writeCursor')(
    function* (cursor: TranscriptCursor) {
      yield* upsertCursor(cursor)
      yield* Effect.logDebug('Stored a transcript cursor', cursor)
    },
    (effect, cursor) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logError('Could not store a transcript cursor', {
            sessionId: cursor.sessionId,
            cause
          })
        ),
        Effect.mapError((cause) => new AgentEventWriteError({ cause }))
      )
  )

  return AgentEventStore.of({
    append,
    appendTranscript,
    committed: Stream.fromPubSub(committedEvents),
    readAfter,
    readHistory,
    lastSequence,
    highestSequence,
    readCursor,
    writeCursor
  })
})

/** Provides {@link AgentEventStore} over the Host's `SqlClient` from `makeHostDatabaseLive`. */
export const AgentEventStoreLive = Layer.effect(AgentEventStore, makeStore)
