import {
  type AgentEvent,
  AgentEvent as AgentEventSchema,
  AgentItem
} from '@shared/domain/agent-event'
import { Clock, Context, Data, Effect, Layer, Option, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

/** `append` stored nothing from its batch. Carries the `SqlError`. */
export class AgentEventWriteError extends Data.TaggedError('AgentEventWriteError')<{
  readonly cause: unknown
}> {}

/** `readItems` could not read `host.db`. Carries the `SqlError`. */
export class AgentEventReadError extends Data.TaggedError('AgentEventReadError')<{
  readonly cause: unknown
}> {}

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
     * Up to `limit` items of agent `agentId` whose position is above `afterPosition` (from the
     * first item when absent), in position order. A stored item that does not decode is left out
     * and logged. Fails with {@link AgentEventReadError} when `host.db` cannot be read.
     */
    readonly readItems: (
      agentId: string,
      page: { readonly afterPosition?: number; readonly limit: number }
    ) => Effect.Effect<ReadonlyArray<AgentItem>, AgentEventReadError>
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

  return AgentEventStore.of({ append, readItems })
})

/** Provides {@link AgentEventStore} over the Host's `SqlClient` from `makeHostDatabaseLive`. */
export const AgentEventStoreLive = Layer.effect(AgentEventStore, makeStore)
