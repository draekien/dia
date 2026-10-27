import {
  ActivityId,
  type ActivityInfo,
  ActivityNotFound,
  ActivityRunning,
  ActivityScheduled,
  type ActivityStatus,
  type LastRun,
  RunFailed,
  RunSucceeded
} from '@shared/domain/background-activity'
import { ActivitiesChanged } from '@shared/ipc/contract'
import type { ActivityHandle, ActivitySpec } from '@shared/plugin/api'
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore
} from 'effect'
import { EventHub } from './event-hub'

/**
 * Longest single sleep of an activity's scheduler. The scheduler re-reads the clock after each
 * sleep, so a system suspend or clock change delays a due run by at most this much.
 */
export const ACTIVITY_RECHECK = Duration.minutes(5)

/** Delay before the next run after a run that ended with a defect instead of a result. */
export const ACTIVITY_DEFECT_RETRY = Duration.hours(1)

/** Longest failure message an activity keeps; a longer one is cut to this many characters. */
export const ACTIVITY_MESSAGE_LIMIT = 500

const DEFECT_MESSAGE = 'Unexpected error; see the log'

interface Activity {
  readonly plugin: string
  readonly id: ActivityId
  readonly label: string
  readonly status: Ref.Ref<ActivityStatus>
  readonly runNow: Effect.Effect<void>
}

/**
 * Every background activity the Host's plugins registered. `register` schedules an activity for
 * a plugin until the calling scope closes; the Host binds it to each plugin as
 * `ctx.activities.register`. `list` reports every registered activity in registration order;
 * `runNow` starts a run of one activity, or waits for the run in progress, and completes when it
 * ends. Every registration, removal and state change is published as an `ActivitiesChanged`
 * event. Provide it with {@link BackgroundActivitiesLive}.
 */
export class BackgroundActivities extends Context.Service<
  BackgroundActivities,
  {
    readonly register: (
      plugin: string,
      spec: ActivitySpec
    ) => Effect.Effect<ActivityHandle, never, Scope.Scope>
    readonly list: Effect.Effect<ReadonlyArray<ActivityInfo>>
    readonly runNow: (plugin: string, id: string) => Effect.Effect<void, ActivityNotFound>
  }
>()('BackgroundActivities') {}

const keyOf = (plugin: string, id: string): string => `${plugin}/${id}`

const truncate = (message: string): string =>
  message.length > ACTIVITY_MESSAGE_LIMIT ? message.slice(0, ACTIVITY_MESSAGE_LIMIT) : message

/** Live {@link BackgroundActivities}. Requires `EventHub`. */
export const BackgroundActivitiesLive = Layer.effect(
  BackgroundActivities,
  Effect.gen(function* () {
    const hub = yield* EventHub
    const activities = new Map<string, Activity>()
    const changed = hub.publish(ActivitiesChanged.make({}))

    const register = Effect.fnUntraced(function* (plugin: string, spec: ActivitySpec) {
      if (!Schema.is(ActivityId)(spec.id)) {
        return yield* Effect.die(
          new Error(`Plugin "${plugin}" registered an activity with the invalid id "${spec.id}"`)
        )
      }
      const key = keyOf(plugin, spec.id)
      if (activities.has(key)) {
        return yield* Effect.die(
          new Error(`Plugin "${plugin}" registered the activity "${spec.id}" twice`)
        )
      }
      const scope = yield* Effect.scope
      const status = yield* Ref.make<ActivityStatus>(
        ActivityScheduled.make({ nextRunAt: spec.firstRunAt })
      )
      const current = yield* Ref.make(Option.none<Deferred.Deferred<void>>())
      const lock = yield* Semaphore.make(1)
      const annotations = { plugin, activity: spec.id }

      const recordedOutcome = (
        exit: Exit.Exit<DateTime.Utc, { readonly message: string; readonly retryAt: DateTime.Utc }>,
        at: DateTime.Utc
      ): Effect.Effect<{ readonly nextRunAt: DateTime.Utc; readonly lastRun: LastRun }> =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) {
            yield* Effect.logInfo('Background activity run succeeded', {
              ...annotations,
              nextRunAt: DateTime.formatIso(exit.value)
            })
            return { nextRunAt: exit.value, lastRun: RunSucceeded.make({ at }) }
          }
          const failure = Cause.findError(exit.cause)
          if (failure._tag === 'Success') {
            yield* Effect.logWarning('Background activity run failed', {
              ...annotations,
              message: failure.success.message,
              retryAt: DateTime.formatIso(failure.success.retryAt)
            })
            return {
              nextRunAt: failure.success.retryAt,
              lastRun: RunFailed.make({ at, message: truncate(failure.success.message) })
            }
          }
          yield* Effect.logError('Background activity run ended with a defect', {
            ...annotations,
            cause: exit.cause
          })
          return {
            nextRunAt: DateTime.addDuration(at, ACTIVITY_DEFECT_RETRY),
            lastRun: RunFailed.make({ at, message: DEFECT_MESSAGE })
          }
        })

      const execute = (done: Deferred.Deferred<void>) =>
        Effect.gen(function* () {
          yield* Effect.logInfo('Background activity run started', annotations)
          const exit = yield* Effect.exit(spec.run)
          const at = yield* DateTime.now
          const outcome = yield* recordedOutcome(exit, at)
          yield* Ref.set(status, ActivityScheduled.make(outcome))
          yield* changed
        }).pipe(
          Effect.ensuring(
            Ref.set(current, Option.none()).pipe(Effect.andThen(Deferred.done(done, Exit.void)))
          )
        )

      const startRun = (
        onlyIfDue: boolean
      ): Effect.Effect<Option.Option<Deferred.Deferred<void>>> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (scope.state._tag === 'Closed') return Option.none()
            const running = yield* Ref.get(current)
            if (Option.isSome(running)) return running
            const now = yield* DateTime.now
            const state = yield* Ref.get(status)
            if (
              onlyIfDue &&
              state._tag === 'Scheduled' &&
              DateTime.isLessThan(now, state.nextRunAt)
            ) {
              return Option.none()
            }
            const done = yield* Deferred.make<void>()
            yield* Ref.set(current, Option.some(done))
            yield* Ref.set(status, ActivityRunning.make({ lastRun: state.lastRun }))
            yield* changed
            yield* Effect.forkIn(execute(done), scope)
            return Option.some(done)
          })
        )

      const awaitRun = (run: Option.Option<Deferred.Deferred<void>>): Effect.Effect<void> =>
        Option.match(run, { onNone: () => Effect.void, onSome: Deferred.await })

      const runNow = startRun(false).pipe(Effect.flatMap(awaitRun))

      const scheduler = Effect.gen(function* () {
        while (true) {
          const state = yield* Ref.get(status)
          const now = yield* DateTime.now
          if (state._tag === 'Scheduled' && DateTime.isLessThan(now, state.nextRunAt)) {
            yield* Effect.sleep(
              Duration.min(DateTime.distance(now, state.nextRunAt), ACTIVITY_RECHECK)
            )
            continue
          }
          yield* awaitRun(yield* startRun(true))
        }
      })

      activities.set(key, { plugin, id: spec.id, label: spec.label, status, runNow })
      yield* Scope.addFinalizer(
        scope,
        Effect.gen(function* () {
          activities.delete(key)
          const running = yield* Ref.get(current)
          if (Option.isSome(running)) yield* Deferred.done(running.value, Exit.void)
          yield* Effect.logInfo('Background activity removed', annotations)
          yield* changed
        })
      )
      yield* Effect.forkIn(scheduler, scope)
      yield* Effect.logInfo('Background activity registered', {
        ...annotations,
        firstRunAt: DateTime.formatIso(spec.firstRunAt)
      })
      yield* changed
      return { runNow } satisfies ActivityHandle
    })

    const list = Effect.suspend(() =>
      Effect.forEach([...activities.values()], (activity) =>
        Ref.get(activity.status).pipe(
          Effect.map(
            (status): ActivityInfo => ({
              plugin: activity.plugin,
              id: activity.id,
              label: activity.label,
              status
            })
          )
        )
      )
    )

    const runNow = (plugin: string, id: string): Effect.Effect<void, ActivityNotFound> => {
      const activity = activities.get(keyOf(plugin, id))
      return activity === undefined
        ? Effect.fail(new ActivityNotFound({ plugin, id }))
        : activity.runNow
    }

    return BackgroundActivities.of({ register, list, runNow })
  })
)
