import {
  type AgentEvent,
  AgentEvent as AgentEventSchema,
  AgentItem
} from '@shared/domain/agent-event'
import { SessionId } from '@shared/domain/pane'
import { Array as Arr, Clock, Context, Data, Effect, Layer, Option, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import type { TranscriptEntry, TranscriptTail } from '../session/agent-backend'

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
     * agent's items to match. `sourceUuid` is the SDK message uuid an event came from; an event
     * whose `sourceUuid` and item are already stored is skipped. Returns one entry per input event:
     * `Some(sequence)` when appended, `None` when skipped. Sequences increase but are not
     * contiguous. Fails with {@link AgentEventWriteError}, and then nothing from the batch is stored.
     */
    readonly append: (
      agentId: string,
      events: ReadonlyArray<{ readonly event: AgentEvent; readonly sourceUuid?: string }>
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
     */
    readonly appendTranscript: (
      agentId: string,
      sessionId: SessionId,
      tail: TranscriptTail
    ) => Effect.Effect<void, AgentEventWriteError | AgentEventReadError>
    /**
     * Up to `limit` items of agent `agentId` whose position is above `afterPosition` (from the
     * first item when absent), in position order. A stored item that does not decode is left out
     * and logged. Fails with {@link AgentEventReadError} when `host.db` cannot be read.
     */
    readonly readItems: (
      agentId: string,
      page: { readonly afterPosition?: number; readonly limit: number }
    ) => Effect.Effect<ReadonlyArray<AgentItem>, AgentEventReadError>
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

const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(AgentEventSchema))
const decodePayload = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeItem = Schema.decodeUnknownResult(AgentItem)

interface ItemWrite {
  readonly itemId: string
  readonly kind: ItemKind
  readonly streaming: boolean
  readonly payload: object
  readonly keepExisting: boolean
}

const itemWriteOf = (event: AgentEvent): ItemWrite | null => {
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

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

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
    event: AgentEvent,
    item: ItemWrite | null,
    occurredAt: number
  ) => {
    if (item !== null) return writeItem(agentId, item)
    switch (event._tag) {
      case 'AgentArchived':
        return sql`UPDATE agents SET archived_at = ${occurredAt} WHERE agent_id = ${agentId}`
      case 'AgentUnarchived':
        return sql`UPDATE agents SET archived_at = NULL WHERE agent_id = ${agentId}`
      default:
        return Effect.void
    }
  }

  const appendOne = Effect.fnUntraced(function* (
    agentId: string,
    input: { readonly event: AgentEvent; readonly sourceUuid?: string },
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

  const append = Effect.fn('AgentEventStore.append')(
    function* (
      agentId: string,
      events: ReadonlyArray<{ readonly event: AgentEvent; readonly sourceUuid?: string }>
    ) {
      const occurredAt = yield* Clock.currentTimeMillis
      const sequences = yield* sql.withTransaction(
        Effect.forEach(events, (input) => appendOne(agentId, input, occurredAt))
      )
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
      const cursorWrite =
        index === batches.length - 1 ? Effect.asVoid(upsertCursor(cursor)) : Effect.void
      yield* asTranscriptWrite(
        agentId,
        sessionId
      )(
        sql.withTransaction(
          Effect.forEach(batch, (entry) => appendOne(agentId, entry, occurredAt)).pipe(
            Effect.andThen(cursorWrite)
          )
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

  const readItems = Effect.fn('AgentEventStore.readItems')(
    function* (agentId: string, page: { readonly afterPosition?: number; readonly limit: number }) {
      const rows = yield* sql<ItemRow>`
        SELECT item_id, position, kind, streaming, payload_json FROM agent_items
        WHERE agent_id = ${agentId} AND position > ${page.afterPosition ?? -1}
        ORDER BY position LIMIT ${page.limit}`
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
      return items
    },
    (effect, agentId) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logError('Could not read agent items', { agentId, cause })
        ),
        Effect.mapError((cause) => new AgentEventReadError({ cause }))
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

  return AgentEventStore.of({ append, appendTranscript, readItems, readCursor, writeCursor })
})

/** Provides {@link AgentEventStore} over the Host's `SqlClient` from `makeHostDatabaseLive`. */
export const AgentEventStoreLive = Layer.effect(AgentEventStore, makeStore)
