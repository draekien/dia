import { Clock, Effect, FileSystem } from 'effect'
import { SqlClient } from 'effect/sql'

const LEGACY_TABLES = ['agent_events', 'agent_items', 'agent_transcript_cursors'] as const

const copyRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const present = yield* sql<{ readonly name: string }>`SELECT name FROM host.sqlite_master
    WHERE type = 'table' AND name IN ${sql.in(LEGACY_TABLES)}`
  if (present.length < LEGACY_TABLES.length) {
    yield* Effect.logInfo('host.db holds no event log to copy', {
      tables: present.map((row) => row.name)
    })
    return { events: 0, items: 0, cursors: 0 }
  }
  const events = yield* sql<{ readonly sequence: number }>`INSERT INTO main.run_events
    (sequence, run_id, event_type, item_id, source_uuid, occurred_at, payload_json)
    SELECT sequence, agent_id, event_type, item_id, source_uuid, occurred_at, payload_json
    FROM host.agent_events ORDER BY sequence RETURNING sequence`
  const items = yield* sql<{ readonly item_id: string }>`INSERT INTO main.run_items
    (run_id, item_id, position, kind, streaming, payload_json)
    SELECT agent_id, item_id, position, kind, streaming, payload_json
    FROM host.agent_items RETURNING item_id`
  const cursors = yield* sql<{ readonly session_id: string }>`INSERT INTO main.transcript_cursors
    (session_id, last_uuid, file_size, mtime_ms)
    SELECT session_id, last_uuid, file_size, mtime_ms
    FROM host.agent_transcript_cursors RETURNING session_id`
  return { events: events.length, items: items.length, cursors: cursors.length }
})

const copyFrom = (hostDatabase: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ATTACH DATABASE ${hostDatabase} AS host`
    const copied = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const counts = yield* copyRows
          yield* sql`INSERT INTO handover ${sql.insert({
            id: 1,
            copied_at: yield* Clock.currentTimeMillis
          })}`
          return counts
        })
      )
      .pipe(Effect.ensuring(Effect.ignore(sql`DETACH DATABASE host`)))
    yield* Effect.logInfo('Copied the event log from host.db', { hostDatabase, ...copied })
  })

const markDone = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO handover ${sql.insert({ id: 1, copied_at: yield* Clock.currentTimeMillis })}`
})

/**
 * Copies the kernel's event log (`agent_events`, `agent_items`, `agent_transcript_cursors`) from
 * the `host.db` at `hostDatabase` into the plugin's database, once: it does nothing when the
 * plugin's `handover` row exists, and it writes that row in the same transaction as the copy.
 * Events keep their sequences; an agent id becomes the run id. `host.db` is only read. A missing
 * file or missing tables copy nothing and still mark the handover done. Call it after the plugin's
 * migrations and before anything appends to the log. Fails when the copy fails, leaving nothing
 * copied, so a later start retries it.
 */
export const handOverFromHostDatabase = Effect.fn('RunEvents.handOver')(function* (
  hostDatabase: string
) {
  const sql = yield* SqlClient.SqlClient
  const done = yield* sql<{ readonly id: number }>`SELECT id FROM handover`
  if (done.length > 0) {
    yield* Effect.logDebug('The event log was already copied from host.db')
    return
  }
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(hostDatabase))) {
    yield* Effect.logInfo('No host.db to copy the event log from', { hostDatabase })
    return yield* markDone
  }
  yield* copyFrom(hostDatabase)
})
