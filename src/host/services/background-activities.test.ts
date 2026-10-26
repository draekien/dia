import { assert, describe, it } from '@effect/vitest'
import { ActivityScheduled, RunFailed, RunSucceeded } from '@shared/domain/background-activity'
import { ActivityRunFailed, type ActivitySpec } from '@shared/plugin/api'
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Stream
} from 'effect'
import { TestClock } from 'effect/testing'
import {
  ACTIVITY_DEFECT_RETRY,
  ACTIVITY_MESSAGE_LIMIT,
  BackgroundActivities,
  BackgroundActivitiesLive
} from './background-activities'
import { EventHub, makeEventHubLive } from './event-hub'

const layer = Layer.provideMerge(BackgroundActivitiesLive, makeEventHubLive())

const at = (duration: Duration.Input): DateTime.Utc =>
  DateTime.makeUnsafe(Duration.toMillis(Duration.fromInputUnsafe(duration)))

const START = at(0)
const IN_A_DAY = at(Duration.days(1))

const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const spec = (overrides: Partial<ActivitySpec>): ActivitySpec => ({
  id: 'models',
  label: 'Model list',
  firstRunAt: START,
  run: Effect.succeed(IN_A_DAY),
  ...overrides
})

const counting = (next: DateTime.Utc) => {
  const counter = { runs: 0 }
  const run = Effect.sync(() => {
    counter.runs += 1
    return next
  })
  return { counter, run }
}

const statusOf = (id: string) =>
  Effect.gen(function* () {
    const activities = yield* BackgroundActivities
    const all = yield* activities.list
    return all.find((activity) => activity.id === id)?.status
  })

describe('BackgroundActivities', () => {
  it.effect(
    'runs an activity whose first run is already due and schedules the time it returns',
    () =>
      Effect.gen(function* () {
        const activities = yield* BackgroundActivities
        const { counter, run } = counting(IN_A_DAY)

        yield* activities.register('claude-code', spec({ run }))
        yield* settle

        assert.strictEqual(counter.runs, 1)
        assert.deepStrictEqual(
          yield* statusOf('models'),
          ActivityScheduled.make({ nextRunAt: IN_A_DAY, lastRun: RunSucceeded.make({ at: START }) })
        )
      }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.effect('does not run before the due time and runs once the clock reaches it', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities
      const { counter, run } = counting(at(Duration.days(2)))

      yield* activities.register('claude-code', spec({ firstRunAt: IN_A_DAY, run }))
      yield* TestClock.adjust(Duration.subtract(Duration.days(1), Duration.millis(1)))
      yield* settle
      const before = counter.runs
      yield* TestClock.adjust(Duration.millis(1))
      yield* settle

      assert.strictEqual(before, 0)
      assert.strictEqual(counter.runs, 1)
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.effect('runs once the clock is set past the due time', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities
      const { counter, run } = counting(at(Duration.days(2)))
      yield* activities.register('claude-code', spec({ firstRunAt: IN_A_DAY, run }))
      yield* settle

      yield* TestClock.setTime(Duration.toMillis(Duration.days(1)) + 1)
      yield* settle

      assert.strictEqual(counter.runs, 1)
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.effect('records a failed run, cut to the message limit, and schedules its retry time', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities
      const retryAt = at(Duration.hours(1))
      const message = 'x'.repeat(ACTIVITY_MESSAGE_LIMIT + 100)

      yield* activities.register(
        'claude-code',
        spec({ run: Effect.fail(new ActivityRunFailed({ message, retryAt })) })
      )
      yield* settle

      assert.deepStrictEqual(
        yield* statusOf('models'),
        ActivityScheduled.make({
          nextRunAt: retryAt,
          lastRun: RunFailed.make({ at: START, message: message.slice(0, ACTIVITY_MESSAGE_LIMIT) })
        })
      )
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.effect('records a run that dies as failed and retries after the defect delay', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities

      yield* activities.register('claude-code', spec({ run: Effect.die('boom') }))
      yield* settle

      assert.deepStrictEqual(
        yield* statusOf('models'),
        ActivityScheduled.make({
          nextRunAt: at(ACTIVITY_DEFECT_RETRY),
          lastRun: RunFailed.make({ at: START, message: 'Unexpected error; see the log' })
        })
      )
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.effect('joins the run in progress instead of starting a second one', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities
      const gate = yield* Deferred.make<void>()
      const counter = { runs: 0 }
      const run = Effect.sync(() => {
        counter.runs += 1
      }).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(IN_A_DAY))
      const handle = yield* activities.register('claude-code', spec({ firstRunAt: IN_A_DAY, run }))

      const first = yield* Effect.forkChild(handle.runNow)
      yield* settle
      const second = yield* Effect.forkChild(activities.runNow('claude-code', 'models'))
      yield* settle
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      assert.strictEqual(counter.runs, 1)
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.effect('removes the activity and releases a waiting runNow when its scope closes', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities
      const scope = yield* Scope.make()
      const handle = yield* activities
        .register('claude-code', spec({ firstRunAt: IN_A_DAY, run: Effect.never }))
        .pipe(Scope.provide(scope))
      const waiting = yield* Effect.forkChild(handle.runNow)
      yield* settle

      yield* Scope.close(scope, Exit.void)
      const waited = yield* Fiber.await(waiting)

      assert.isTrue(Exit.isSuccess(waited))
      assert.deepStrictEqual(yield* activities.list, [])
    }).pipe(Effect.provide(layer))
  )

  it.effect('completes runNow without running when the scope has already closed', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities
      const scope = yield* Scope.make()
      const { counter, run } = counting(IN_A_DAY)
      const handle = yield* activities
        .register('claude-code', spec({ firstRunAt: IN_A_DAY, run }))
        .pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)

      const ran = yield* handle.runNow.pipe(
        Effect.timeoutOption(Duration.seconds(1)),
        Effect.forkChild
      )
      yield* TestClock.adjust(Duration.seconds(1))
      const outcome = yield* Fiber.join(ran)

      assert.isTrue(outcome._tag === 'Some')
      assert.strictEqual(counter.runs, 0)
    }).pipe(Effect.provide(layer))
  )

  it.effect('fails runNow with ActivityNotFound for an activity no plugin registered', () =>
    Effect.gen(function* () {
      const activities = yield* BackgroundActivities

      const error = yield* Effect.flip(activities.runNow('claude-code', 'models'))

      assert.deepStrictEqual(
        [error._tag, error.plugin, error.id],
        ['ActivityNotFound', 'claude-code', 'models']
      )
    }).pipe(Effect.provide(layer))
  )

  for (const [name, ids] of [
    ['an id registered twice by one plugin', ['models', 'models']],
    ['an id that is not an ActivityId', ['Models!']]
  ] as const) {
    it.effect(`dies on ${name}`, () =>
      Effect.gen(function* () {
        const activities = yield* BackgroundActivities
        const runs = ids.map((id) =>
          activities.register('claude-code', spec({ id, firstRunAt: IN_A_DAY }))
        )

        const exit = yield* Effect.exit(Effect.all(runs, { discard: true }))

        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      }).pipe(Effect.scoped, Effect.provide(layer))
    )
  }

  it.effect('publishes ActivitiesChanged on registration, each state change, and removal', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      const activities = yield* BackgroundActivities
      const collecting = yield* hub
        .subscribe({})
        .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const scope = yield* Scope.make()

      yield* activities.register('claude-code', spec({})).pipe(Scope.provide(scope))
      yield* settle
      yield* Scope.close(scope, Exit.void)
      const frames = yield* Fiber.join(collecting)

      assert.deepStrictEqual(
        frames.map((frame) => frame._tag === 'GlobalEvent' && frame.event._tag),
        ['ActivitiesChanged', 'ActivitiesChanged', 'ActivitiesChanged', 'ActivitiesChanged']
      )
    }).pipe(Effect.provide(layer))
  )
})
