import { ActivityId, PermissionMode, ServiceKey, ThinkingLevel } from '@dia/plugin'
import { type Effect, Predicate, Schema, SchemaTransformation } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * Repeats every `interval` (at least one second) after the schedule last fired; after times
 * missed under the `skip` catch-up rule, it repeats from now. Encoded as milliseconds.
 */
export const Interval = Schema.TaggedStruct('Interval', {
  interval: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1000)).pipe(
    Schema.decodeTo(Schema.Duration, SchemaTransformation.durationFromMillis)
  )
})

/**
 * Fires at the times of cron `expression` (5 fields, or 6 with seconds first) in IANA
 * `timeZone`; without `timeZone` the times are in the system's time zone.
 */
export const CronTimes = Schema.TaggedStruct('CronTimes', {
  expression: Schema.String,
  timeZone: Schema.optional(Schema.String)
})

/** When a schedule fires: an {@link Interval} or {@link CronTimes}. */
export const ScheduleTimes = Schema.Union([Interval, CronTimes])
export type ScheduleTimes = typeof ScheduleTimes.Type

/**
 * What happens to times missed while dia was closed: `skip` waits for the next time; `once`
 * starts one run at once for any number of missed times.
 */
export const CatchUp = Schema.Literals(['skip', 'once'])
export type CatchUp = typeof CatchUp.Type

/** The `StartRunOptions` a schedule's run starts with; `context` must be JSON. */
export const ScheduledRun = Schema.Struct({
  cwd: Schema.String,
  model: Schema.String,
  thinkingLevel: ThinkingLevel,
  permissionMode: PermissionMode,
  text: Schema.String,
  labels: Schema.optional(Schema.Array(Schema.String)),
  context: Schema.optional(Schema.Json)
})

/**
 * A schedule: `id` (lowercase letters, digits and hyphens, starting with a letter; prefix it with
 * the calling plugin's name) names it and its activity on the Plugins page, where `label` is
 * shown; `times` says when it fires, `catchUp` what happens to times missed while dia was closed,
 * and `run` what run it starts with no tab, queued with `priority` and `key` as `RunQueue.enqueue`
 * takes them.
 */
export const Schedule = Schema.Struct({
  id: ActivityId,
  label: Schema.String,
  times: ScheduleTimes,
  catchUp: CatchUp,
  run: ScheduledRun,
  priority: Schema.optional(Schema.Finite),
  key: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    })
  )
})
export type Schedule = typeof Schedule.Type

/** `put` refused schedule `id`: its cron expression or time zone is invalid (`message` says which). */
export class InvalidSchedule extends Schema.TaggedError<InvalidSchedule>()('InvalidSchedule', {
  id: Schema.String,
  message: Schema.String
}) {}

/**
 * Stores schedules and starts each one's run through the run queue at its times, as
 * `dia-schedules` provides it under {@link SchedulesKey}. Read it with `ctx.whenProvided`.
 *
 * - `put` stores `schedule` under its id and times it. Putting a definition equal to the stored
 *   one changes nothing, so a caller can put its schedules again at every start without resetting
 *   them; a changed definition counts its times from now.
 * - `remove` removes schedule `id` (an absent id does nothing) and completes once no run of it can
 *   start any more: a fire waiting in the queue is withdrawn, and a start in progress has finished.
 */
export interface Schedules {
  readonly put: (schedule: Schedule) => Effect.Effect<void, InvalidSchedule>
  readonly remove: (id: string) => Effect.Effect<void>
}

const isSchedules = (value: unknown): value is Schedules =>
  (['put', 'remove'] as const).every(
    (member) => Predicate.hasProperty(value, member) && Predicate.isFunction(value[member])
  )

/**
 * The key `dia-schedules` provides its {@link Schedules} under: `schedules`. A value counts when
 * `put` and `remove` are functions.
 */
export const SchedulesKey = ServiceKey.make('schedules', isSchedules)

/** Plugin call for `Schedules.put`; fails with {@link InvalidSchedule}. */
export const PutSchedule = Rpc.make('PutSchedule', {
  payload: { schedule: Schedule },
  error: InvalidSchedule
})

/** Plugin call for `Schedules.remove`. */
export const RemoveSchedule = Rpc.make('RemoveSchedule', {
  payload: { scheduleId: Schema.String }
})
