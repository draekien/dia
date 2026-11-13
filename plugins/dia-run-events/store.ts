import {
  AgentEvents,
  type AppendEntry,
  CommittedEvent,
  ReloadRequired,
  Replay,
  type ReplayLimits,
  RunEventReadError,
  RunEventWriteError,
  type SessionId,
  StoredEvent,
  TranscriptCursor
} from '@dia/plugin'
import type { TranscriptEntry, TranscriptTail } from '@dia-plugin/dia-runs/backend'
import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Result,
  Schema,
  type Scope,
  Semaphore,
  Stream
} from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * The least number of events one `appendTranscript` write commits together. A call that fails
 * keeps the writes committed before the failure.
 */
export const TRANSCRIPT_BATCH_SIZE = 500

/** Service tag for the run event log and its item projection in the plugin's database. Provide it with {@link RunEventStoreLive}. */
export class RunEventStore extends Context.Service<
  RunEventStore,
  {
    /**
     * Appends `events` to run `runId`'s stream in order, in one transaction, and updates the
     * run's items to match its `AgentEvent`s. `sourceUuid` is the SDK message uuid an event
     * came from; an event whose `sourceUuid` and item are already stored is skipped. Returns one
     * entry per input event: `Some(sequence)` when appended, `None` when skipped. Sequences
     * increase but are not contiguous. Every appended event is offered to `committed` once the
     * transaction commits. Appending an `AgentArchived` event also deletes, for good, the run's
     * `streaming` `MessageUpdated` and `ReasoningUpdated` events that a later event of the same
     * item replaced; replay then skips their sequences. Fails with {@link RunEventWriteError},
     * and then nothing from the batch is stored, deleted or offered.
     */
    readonly append: (
      runId: string,
      events: ReadonlyArray<AppendEntry>
    ) => Effect.Effect<ReadonlyArray<Option.Option<number>>, RunEventWriteError>
    /**
     * Appends to run `runId` the entries of `tail`, read from SDK session `sessionId`'s
     * transcript, skipping each entry whose `sourceUuid` the run already has an event for, then
     * stores the session's cursor at the tail's last entry (skipped or not) with the tail's size
     * and mtime. All events of one source uuid are stored together or not at all. A tail with no
     * entries updates only the size and mtime of an existing cursor, and stores nothing when none
     * exists. Fails with {@link RunEventReadError} when the stored source uuids cannot be read,
     * and with {@link RunEventWriteError} when a write fails; the entries stored before the
     * failure stay, the cursor is unchanged, and calling again with the same tail stores the rest.
     * Each committed batch is offered to `committed`.
     */
    readonly appendTranscript: (
      runId: string,
      sessionId: SessionId,
      tail: TranscriptTail
    ) => Effect.Effect<void, RunEventWriteError | RunEventReadError>
    /**
     * Every event committed from now on, by any run, in commit order (which is sequence order).
     * Each subscriber receives the events committed after it subscribed; events are never
     * dropped, and the store never waits for a subscriber.
     */
    readonly committed: Stream.Stream<CommittedEvent>
    /**
     * Subscribes at once, in the calling scope, and returns the events committed after the call,
     * by any run, in sequence order. Use it, not `committed`, to read a state and then the events
     * after it: `committed` subscribes only when it is first pulled.
     */
    readonly subscribe: Effect.Effect<Stream.Stream<CommittedEvent>, never, Scope.Scope>
    /**
     * The events of run `runId` after sequence `afterSequence`, read in one transaction: a
     * {@link Replay}, or {@link ReloadRequired} when they cannot be replayed within `limits` (the
     * byte limit counts each event's stored JSON in UTF-8). Never fails; a failed read is logged
     * and returned as `readFailed`.
     */
    readonly readAfter: (
      runId: string,
      afterSequence: number,
      limits: ReplayLimits
    ) => Effect.Effect<Replay | ReloadRequired>
    /**
     * All items of run `runId` in position order, and `through`: the run's highest sequence
     * (0 when it has none) when they were read, in one transaction. The items are the run's
     * conversation after every event up to `through`. A stored item that does not decode is left
     * out and logged. Fails with {@link RunEventReadError} when the database cannot be read.
     */
    readonly readHistory: (
      runId: string
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<AgentEvents.AgentItem>; readonly through: number },
      RunEventReadError
    >
    /**
     * The highest sequence of run `runId`, or 0 when it has none. Fails with
     * {@link RunEventReadError} when the database cannot be read.
     */
    readonly lastSequence: (runId: string) => Effect.Effect<number, RunEventReadError>
    /**
     * The highest sequence of any run, or 0 when none has an event. Fails with
     * {@link RunEventReadError} when the database cannot be read.
     */
    readonly highestSequence: Effect.Effect<number, RunEventReadError>
    /**
     * The stored cursor of SDK session `sessionId`, or none when there is none. Fails with
     * {@link RunEventReadError} when the database cannot be read.
     */
    readonly readCursor: (
      sessionId: SessionId
    ) => Effect.Effect<Option.Option<TranscriptCursor>, RunEventReadError>
    /**
     * Stores `cursor` as its session's cursor, replacing any earlier one. Fails with
     * {@link RunEventWriteError}, and then the earlier cursor stays.
     */
    readonly writeCursor: (cursor: TranscriptCursor) => Effect.Effect<void, RunEventWriteError>
  }
>()('RunEventStore') {}

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
const decodeItem = Schema.decodeUnknownResult(AgentEvents.AgentItem)

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

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const writes = yield* Semaphore.make(1)
  const committedEvents = yield* PubSub.unbounded<CommittedEvent>()

  const writeItem = (runId: string, item: ItemWrite) =>
    sql`INSERT INTO run_items (run_id, item_id, position, kind, streaming, payload_json)
      VALUES (${runId}, ${item.itemId},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM run_items WHERE run_id = ${runId}),
        ${item.kind}, ${item.streaming ? 1 : 0}, ${JSON.stringify(item.payload)})
      ON CONFLICT (run_id, item_id) ${sql.literal(
        item.keepExisting
          ? 'DO NOTHING'
          : 'DO UPDATE SET kind = excluded.kind, streaming = excluded.streaming, payload_json = excluded.payload_json'
      )}`

  const deleteSupersededStreaming = (runId: string) =>
    sql`DELETE FROM run_events WHERE sequence IN (
      SELECT sequence FROM (
        SELECT sequence, event_type,
          json_extract(payload_json, '$.streaming') AS streaming,
          ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY sequence DESC) AS newer
        FROM run_events WHERE run_id = ${runId} AND item_id IS NOT NULL)
      WHERE newer > 1 AND streaming = 1
        AND event_type IN ('MessageUpdated', 'ReasoningUpdated'))
      RETURNING sequence`.pipe(
      Effect.tap((deleted) =>
        Effect.logInfo('Compacted an archived run', { runId, deleted: deleted.length })
      )
    )

  const project = (runId: string, event: StoredEvent, item: ItemWrite | null) => {
    if (item !== null) return writeItem(runId, item)
    switch (event._tag) {
      case 'AgentArchived':
        return deleteSupersededStreaming(runId)
      case 'ConversationCleared':
        return sql`DELETE FROM run_items WHERE run_id = ${runId}`
      case 'ConversationRewound':
        return sql`DELETE FROM run_items WHERE run_id = ${runId} AND position >= (
          SELECT position FROM run_items WHERE run_id = ${runId} AND kind = 'message'
            AND json_extract(payload_json, '$.message.checkpointUuid') = ${event.checkpointUuid})`
      default:
        return Effect.void
    }
  }

  const appendOne = Effect.fnUntraced(function* (
    runId: string,
    input: AppendEntry,
    occurredAt: number
  ) {
    const item = itemWriteOf(input.event)
    const inserted = yield* sql<{
      readonly sequence: number
    }>`INSERT INTO run_events ${sql.insert({
      run_id: runId,
      event_type: input.event._tag,
      item_id: item?.itemId ?? null,
      source_uuid: input.sourceUuid ?? null,
      occurred_at: occurredAt,
      payload_json: encodeEventJson(input.event)
    })} ON CONFLICT DO NOTHING RETURNING sequence`
    if (inserted.length === 0) return Option.none<number>()
    yield* project(runId, input.event, item)
    return Option.some(inserted[0].sequence)
  })

  const commit = <E>(
    runId: string,
    entries: ReadonlyArray<AppendEntry>,
    occurredAt: number,
    alsoWrite: Effect.Effect<void, E>
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const sequences = yield* sql.withTransaction(
          Effect.forEach(entries, (input) => appendOne(runId, input, occurredAt)).pipe(
            Effect.tap(() => alsoWrite)
          )
        )
        yield* PubSub.publishAll(
          committedEvents,
          entries.flatMap((entry, index) =>
            Option.match(sequences[index] ?? Option.none(), {
              onNone: () => [],
              onSome: (sequence) => [CommittedEvent.make({ runId, sequence, event: entry.event })]
            })
          )
        )
        return sequences
      })
    )

  const append = Effect.fn('RunEventStore.append')(
    function* (runId: string, events: ReadonlyArray<AppendEntry>) {
      const occurredAt = yield* Clock.currentTimeMillis
      const sequences = yield* commit(runId, events, occurredAt, Effect.void)
      const appended = sequences.filter(Option.isSome).length
      yield* Effect.logDebug('Appended run events', {
        runId,
        events: events.length,
        appended,
        skipped: events.length - appended
      })
      return sequences
    },
    (effect, runId) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logError('Could not append run events', { runId, cause })
        ),
        Effect.mapError((cause) => new RunEventWriteError({ cause }))
      )
  )

  const upsertCursor = (cursor: TranscriptCursor) =>
    sql`INSERT INTO transcript_cursors ${sql.insert({
      session_id: cursor.sessionId,
      last_uuid: cursor.lastUuid,
      file_size: cursor.fileSize,
      mtime_ms: cursor.mtimeMs
    })} ON CONFLICT (session_id) DO UPDATE SET last_uuid = excluded.last_uuid,
      file_size = excluded.file_size, mtime_ms = excluded.mtime_ms`

  const storedSourceUuids = (runId: string, entries: ReadonlyArray<TranscriptEntry>) =>
    sql<{ readonly source_uuid: string }>`SELECT DISTINCT source_uuid FROM run_events
      WHERE run_id = ${runId} AND source_uuid IN (SELECT value FROM json_each(${JSON.stringify(
        entries.map((entry) => entry.sourceUuid)
      )}))`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.source_uuid))),
      Effect.tapError((cause) =>
        Effect.logError('Could not read stored source uuids', { runId, cause })
      ),
      Effect.mapError((cause) => new RunEventReadError({ cause }))
    )

  const asTranscriptWrite =
    (runId: string, sessionId: SessionId) =>
    <A, E, R>(write: Effect.Effect<A, E, R>) =>
      write.pipe(
        Effect.tapError((cause) =>
          Effect.logError('Could not append transcript entries', { runId, sessionId, cause })
        ),
        Effect.mapError((cause) => new RunEventWriteError({ cause }))
      )

  const appendTranscript = Effect.fn('RunEventStore.appendTranscript')(function* (
    runId: string,
    sessionId: SessionId,
    tail: TranscriptTail
  ) {
    const lastEntry = Arr.last(tail.entries)
    if (Option.isNone(lastEntry)) {
      yield* asTranscriptWrite(
        runId,
        sessionId
      )(sql`UPDATE transcript_cursors SET file_size = ${tail.fileSize},
        mtime_ms = ${tail.mtimeMs} WHERE session_id = ${sessionId}`)
      yield* Effect.logDebug('Refreshed a transcript cursor for a tail with no entries', {
        sessionId,
        fileSize: tail.fileSize,
        mtimeMs: tail.mtimeMs
      })
      return
    }
    const known = yield* storedSourceUuids(runId, tail.entries)
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
        runId,
        sessionId
      )(
        commit(runId, batch, occurredAt, isLast ? Effect.asVoid(upsertCursor(cursor)) : Effect.void)
      )
    }
    yield* Effect.logDebug('Appended transcript entries', {
      runId,
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
        Effect.mapError((cause) => new RunEventReadError({ cause }))
      )

  const maxSequenceOf = (runId: string) =>
    Effect.map(
      sql<{ readonly through: number }>`SELECT COALESCE(MAX(sequence), 0) AS through
        FROM run_events WHERE run_id = ${runId}`,
      (rows) => rows[0]?.through ?? 0
    )

  const readHistory = Effect.fn('RunEventStore.readHistory')(function* (runId: string) {
    const { rows, through } = yield* asRead('Could not read run history', { runId })(
      sql.withTransaction(
        Effect.all({
          rows: sql<ItemRow>`SELECT item_id, position, kind, streaming, payload_json
            FROM run_items WHERE run_id = ${runId} ORDER BY position`,
          through: maxSequenceOf(runId)
        })
      )
    )
    const items: Array<AgentEvents.AgentItem> = []
    for (const row of rows) {
      const item = itemFromRow(row)
      if (Result.isSuccess(item)) {
        items.push(item.success)
        continue
      }
      yield* Effect.logWarning('Left out a run item that does not decode', {
        runId,
        itemId: row.item_id,
        reason: item.failure.message
      })
    }
    yield* Effect.logDebug('Read run history', { runId, items: items.length, through })
    return { items, through }
  })

  const readRange = (runId: string, afterSequence: number, limits: ReplayLimits) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const through = yield* maxSequenceOf(runId)
        if (afterSequence > through) return ReloadRequired.make({ reason: 'ahead' })
        const [counted] = yield* sql<{ readonly events: number }>`SELECT COUNT(*) AS events
          FROM run_events WHERE run_id = ${runId}
            AND sequence > ${afterSequence} AND sequence <= ${through}`
        if ((counted?.events ?? 0) > limits.maxEvents) {
          return ReloadRequired.make({ reason: 'tooLarge' })
        }
        const [sized] = yield* sql<{ readonly bytes: number }>`SELECT
            COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS bytes
          FROM run_events WHERE run_id = ${runId}
            AND sequence > ${afterSequence} AND sequence <= ${through}`
        if ((sized?.bytes ?? 0) > limits.maxBytes) {
          return ReloadRequired.make({ reason: 'tooLarge' })
        }
        const rows = yield* sql<{
          readonly sequence: number
          readonly payload_json: string
        }>`SELECT sequence, payload_json FROM run_events WHERE run_id = ${runId}
          AND sequence > ${afterSequence} AND sequence <= ${through} ORDER BY sequence`
        const events: Array<CommittedEvent> = []
        for (const row of rows) {
          const event = decodeEventJson(row.payload_json)
          if (Result.isFailure(event)) {
            yield* Effect.logWarning('A stored run event does not decode', {
              runId,
              sequence: row.sequence,
              reason: event.failure.message
            })
            return ReloadRequired.make({ reason: 'undecodable' })
          }
          events.push(CommittedEvent.make({ runId, sequence: row.sequence, event: event.success }))
        }
        return Replay.make({ events, through })
      })
    )

  const readAfter = Effect.fn('RunEventStore.readAfter')(function* (
    runId: string,
    afterSequence: number,
    limits: ReplayLimits
  ) {
    return yield* readRange(runId, afterSequence, limits).pipe(
      Effect.catch((cause) =>
        Effect.logError('Could not read run events to replay', {
          runId,
          afterSequence,
          cause
        }).pipe(Effect.as(ReloadRequired.make({ reason: 'readFailed' })))
      )
    )
  })

  const lastSequence = (runId: string) =>
    asRead('Could not read the last run event sequence', { runId })(maxSequenceOf(runId))

  const highestSequence = asRead(
    'Could not read the highest run event sequence',
    {}
  )(
    Effect.map(
      sql<{ readonly through: number }>`SELECT COALESCE(MAX(sequence), 0) AS through
        FROM run_events`,
      (rows) => rows[0]?.through ?? 0
    )
  )

  const readCursor = Effect.fn('RunEventStore.readCursor')(
    function* (sessionId: SessionId) {
      const rows = yield* sql<{
        readonly last_uuid: string
        readonly file_size: number
        readonly mtime_ms: number
      }>`SELECT last_uuid, file_size, mtime_ms FROM transcript_cursors
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
        Effect.mapError((cause) => new RunEventReadError({ cause }))
      )
  )

  const writeCursor = Effect.fn('RunEventStore.writeCursor')(
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
        Effect.mapError((cause) => new RunEventWriteError({ cause }))
      )
  )

  return RunEventStore.of({
    append,
    appendTranscript,
    committed: Stream.fromPubSub(committedEvents),
    subscribe: Effect.map(PubSub.subscribe(committedEvents), Stream.fromSubscription),
    readAfter,
    readHistory,
    lastSequence,
    highestSequence,
    readCursor,
    writeCursor
  })
})

/** Provides {@link RunEventStore} over the plugin database's `SqlClient`, migrated with `runEventsMigrations`. */
export const RunEventStoreLive = Layer.effect(RunEventStore, makeStore)
