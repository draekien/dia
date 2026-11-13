import { Cron, DateTime, type Duration, Effect, Result } from 'effect'
import { type CatchUp, InvalidSchedule, type Schedule } from './schedules'

/** A schedule's times, ready for {@link nextTime}: a repeat interval or a parsed cron. */
export type Times =
  | { readonly _tag: 'Interval'; readonly interval: Duration.Duration }
  | { readonly _tag: 'Cron'; readonly cron: Cron.Cron }

/** Parses `schedule.times`; fails with `InvalidSchedule` for a bad cron expression or time zone. */
export const parseTimes = (schedule: Schedule): Effect.Effect<Times, InvalidSchedule> => {
  const times = schedule.times
  if (times._tag === 'Interval') {
    return Effect.succeed({ _tag: 'Interval', interval: times.interval })
  }
  return Result.match(Cron.parse(times.expression, times.timeZone), {
    onSuccess: (cron) => Effect.succeed({ _tag: 'Cron' as const, cron }),
    onFailure: (error) =>
      Effect.fail(new InvalidSchedule({ id: schedule.id, message: error.message }))
  })
}

/** The first time of `times` after `after`. */
export const nextTime = (times: Times, after: DateTime.Utc): DateTime.Utc =>
  times._tag === 'Interval'
    ? DateTime.addDuration(after, times.interval)
    : DateTime.fromDateUnsafe(Cron.next(times.cron, DateTime.toDate(after)))

/**
 * When a schedule registered at `now` and last fired (or stored) at `firedAt` first fires: its
 * next time after `firedAt`, or, when that has passed and `catchUp` is `skip`, its next time after
 * `now`. A time in the past means at once.
 */
export const firstRunAt = (
  times: Times,
  catchUp: CatchUp,
  firedAt: DateTime.Utc,
  now: DateTime.Utc
): DateTime.Utc => {
  const due = nextTime(times, firedAt)
  return catchUp === 'once' || DateTime.isGreaterThan(due, now) ? due : nextTime(times, now)
}
