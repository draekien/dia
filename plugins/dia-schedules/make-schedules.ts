import { ActivityRunFailed, type PluginActivities } from '@dia/plugin'
import type { RunQueue } from '@dia-plugin/dia-run-queue/queue'
import {
  Cause,
  DateTime,
  Effect,
  Exit,
  Option,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef
} from 'effect'
import type { SqlClient } from 'effect/sql'
import { type InvalidSchedule, Schedule, type Schedules } from './schedules'
import { nextRunAt, nextTime, parseTimes, type Times } from './times'

/** What {@link makeSchedules} needs: the plugin's activities, its database, and the run queue when one is provided. */
export interface SchedulesDeps {
  readonly activities: PluginActivities
  readonly sql: SqlClient.SqlClient
  readonly queue: SubscriptionRef.SubscriptionRef<Option.Option<RunQueue>>
}

const DefinitionJson = Schema.fromJsonString(Schedule)
const encodeDefinition = Schema.encodeSync(DefinitionJson)
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.String, definition_json: DefinitionJson, fired_at: Schema.Finite })
)

/**
 * Builds {@link Schedules} on `deps.sql` (migrated with `schedulesMigrations`) and registers every
 * stored schedule as an activity, each until the calling scope closes. A schedule's fire waits
 * for a `RunQueue` in `deps.queue`, so call it in the plugin's setup scope, not in a scope that
 * follows the run queue.
 */
export const makeSchedules = Effect.fnUntraced(function* (deps: SchedulesDeps) {
  const { sql } = deps
  const pluginScope = yield* Effect.scope
  const lock = yield* Semaphore.make(1)
  const live = new Map<string, Scope.Closeable>()

  const queueOtherThan = (used: Option.Option<RunQueue>) =>
    SubscriptionRef.changes(deps.queue).pipe(
      Stream.filter(
        (current) => Option.isSome(current) && (Option.isNone(used) || current.value !== used.value)
      ),
      Stream.runHead,
      Effect.map((found) => Option.getOrThrow(Option.flatten(found)))
    )

  const fire = (schedule: Schedule, times: Times) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const began = yield* DateTime.now
        const annotations = { schedule: schedule.id }
        let used = Option.none<RunQueue>()
        while (true) {
          const queue = yield* restore(queueOtherThan(used))
          const exit = yield* Effect.exit(
            restore(
              queue.enqueue({ run: schedule.run, priority: schedule.priority, key: schedule.key })
            )
          )
          if (Exit.isSuccess(exit)) {
            yield* sql`UPDATE schedules SET fired_at = ${DateTime.toEpochMillis(began)} WHERE id = ${schedule.id}`.pipe(
              Effect.orDie
            )
            const next = nextRunAt(times, schedule.catchUp, began, yield* DateTime.now)
            yield* Effect.logInfo('Schedule started a run', {
              ...annotations,
              runId: exit.value,
              nextRunAt: DateTime.formatIso(next)
            })
            return next
          }
          if (!Cause.hasInterruptsOnly(exit.cause)) {
            const retryAt = nextTime(times, yield* DateTime.now)
            yield* Effect.logError('Schedule could not start its run', {
              ...annotations,
              cause: exit.cause
            })
            return yield* new ActivityRunFailed({
              message: 'The run could not start; see the log',
              retryAt
            })
          }
          yield* Effect.logInfo(
            'Schedule enqueue was interrupted; it enqueues again on the next run queue unless the schedule stopped',
            annotations
          )
          used = Option.some(queue)
        }
      })
    )

  const register = Effect.fnUntraced(function* (
    schedule: Schedule,
    times: Times,
    firedAt: DateTime.Utc
  ) {
    const scope = yield* Scope.fork(pluginScope)
    live.set(schedule.id, scope)
    const now = yield* DateTime.now
    const first = nextRunAt(times, schedule.catchUp, firedAt, now)
    if (schedule.catchUp === 'skip' && !DateTime.isGreaterThan(nextTime(times, firedAt), now)) {
      yield* Effect.logInfo('Schedule skipped the times it missed', { schedule: schedule.id })
    }
    yield* deps.activities
      .register({
        id: schedule.id,
        label: schedule.label,
        firstRunAt: first,
        run: fire(schedule, times)
      })
      .pipe(Scope.provide(scope))
    yield* Effect.logInfo('Schedule registered', {
      schedule: schedule.id,
      firstRunAt: DateTime.formatIso(first)
    })
  })

  const unregister = (id: string) =>
    Effect.suspend(() => {
      const scope = live.get(id)
      live.delete(id)
      return scope === undefined ? Effect.void : Scope.close(scope, Exit.void)
    })

  const rows = yield* sql`SELECT id, definition_json, fired_at FROM schedules`.pipe(Effect.orDie)
  for (const raw of rows) {
    const row = decodeRow(raw)
    if (Option.isNone(row)) {
      yield* Effect.logWarning('Skipped a stored schedule that no longer decodes', { raw })
      continue
    }
    const schedule = row.value.definition_json
    const times = yield* parseTimes(schedule).pipe(Effect.option)
    if (Option.isNone(times)) {
      yield* Effect.logWarning('Skipped a stored schedule whose times no longer parse', {
        schedule: schedule.id
      })
      continue
    }
    yield* register(schedule, times.value, DateTime.makeUnsafe(row.value.fired_at))
  }

  const put = (schedule: Schedule): Effect.Effect<void, InvalidSchedule> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const times = yield* parseTimes(schedule)
        const definition = encodeDefinition(schedule)
        const stored = yield* sql<{
          readonly definition_json: string
        }>`SELECT definition_json FROM schedules WHERE id = ${schedule.id}`.pipe(Effect.orDie)
        if (stored[0]?.definition_json === definition) {
          yield* Effect.logInfo('Schedule unchanged', { schedule: schedule.id })
          return
        }
        yield* unregister(schedule.id)
        const now = yield* DateTime.now
        yield* sql`INSERT INTO schedules (id, definition_json, fired_at)
          VALUES (${schedule.id}, ${definition}, ${DateTime.toEpochMillis(now)})
          ON CONFLICT (id) DO UPDATE SET definition_json = excluded.definition_json, fired_at = excluded.fired_at`.pipe(
          Effect.orDie
        )
        yield* register(schedule, times, now)
      })
    )

  const remove = (id: string): Effect.Effect<void> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* unregister(id)
        yield* sql`DELETE FROM schedules WHERE id = ${id}`.pipe(Effect.orDie)
        yield* Effect.logInfo('Schedule removed', { schedule: id })
      })
    )

  return { put, remove } satisfies Schedules
})
