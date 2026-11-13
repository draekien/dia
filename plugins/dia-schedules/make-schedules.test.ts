import type { QueuedRun, RunQueue } from '@dia-plugin/dia-run-queue/queue'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  SubscriptionRef
} from 'effect'
import { TestClock } from 'effect/testing'
import {
  BackgroundActivities,
  BackgroundActivitiesLive
} from '../../src/host/services/background-activities'
import { openDatabase } from '../../src/host/services/database'
import { EventHubTestLayer } from '../../src/host/services/event-hub-test-layer'
import { makeSchedules } from './make-schedules'
import { schedulesMigrations } from './migrations'
import {
  type CatchUp,
  CronTimes,
  Interval,
  Schedule,
  type ScheduledRun,
  type ScheduleTimes
} from './schedules'

const layer = Layer.mergeAll(
  Layer.provideMerge(BackgroundActivitiesLive, EventHubTestLayer),
  NodeFileSystem.layer,
  NodePath.layer
)

const TEN_MINUTES = Duration.minutes(10)

const run = (text: string): typeof ScheduledRun.Type => ({
  cwd: 'C:/work',
  model: 'haiku',
  thinkingLevel: 'adaptive',
  permissionMode: 'default',
  text
})

const schedule = (
  options: { times?: ScheduleTimes; catchUp?: CatchUp; text?: string } = {}
): Schedule => ({
  id: 'test-report',
  label: 'Report',
  times: options.times ?? Interval.make({ interval: TEN_MINUTES }),
  catchUp: options.catchUp ?? 'skip',
  run: run(options.text ?? 'Write the report')
})

const settle = Effect.gen(function* () {
  for (let i = 0; i < 200; i++) yield* Effect.yieldNow
})

const advance = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(settle))

const recordingQueue = () => {
  const entries: Array<QueuedRun> = []
  const queue: RunQueue = {
    enqueue: (entry) =>
      Effect.sync(() => {
        entries.push(entry)
        return `run-${entries.length}`
      }),
    setLimit: () => Effect.void
  }
  return { entries, queue }
}

const makeWorldIn = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'data.db')
  const activities = yield* BackgroundActivities
  const queueRef = yield* SubscriptionRef.make(Option.none<RunQueue>())
  const recording = recordingQueue()
  const outer = yield* Effect.scope

  const open = Effect.gen(function* () {
    const scope = yield* Scope.fork(outer)
    const schedules = yield* Effect.gen(function* () {
      const sql = yield* openDatabase(filename, schedulesMigrations)
      return yield* makeSchedules({
        activities: { register: (spec) => activities.register('dia-schedules', spec) },
        sql,
        queue: queueRef
      })
    }).pipe(Scope.provide(scope), Effect.orDie)
    yield* settle
    return { schedules, close: Scope.close(scope, Exit.void) }
  })

  const provide = (queue: RunQueue) =>
    SubscriptionRef.set(queueRef, Option.some(queue)).pipe(Effect.andThen(settle))

  return { open, provide, recording, activities }
})

const inWorld = <A, E>(
  body: (
    world: Effect.Success<typeof makeWorldIn>
  ) => Generator<Effect.Effect<unknown, E, Scope.Scope>, A, unknown>
) =>
  makeWorldIn.pipe(
    Effect.flatMap((world) => Effect.gen(() => body(world))),
    Effect.scoped,
    Effect.provide(layer)
  )

describe('makeSchedules', () => {
  it.effect('starts an interval schedule run at its time, with its run options', () =>
    inWorld(function* (world) {
      yield* world.provide(world.recording.queue)
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())

      yield* advance(Duration.minutes(9))
      assert.strictEqual(world.recording.entries.length, 0)

      yield* advance(Duration.minutes(1))
      assert.deepStrictEqual(
        world.recording.entries.map((entry) => entry.run),
        [run('Write the report')]
      )
    })
  )

  it.effect('starts a cron schedule run at its next time in its time zone', () =>
    inWorld(function* (world) {
      yield* world.provide(world.recording.queue)
      const { schedules } = yield* world.open
      yield* schedules.put(
        schedule({ times: CronTimes.make({ expression: '0 9 * * *', timeZone: 'UTC' }) })
      )

      yield* advance(Duration.sum(Duration.hours(8), Duration.minutes(59)))
      assert.strictEqual(world.recording.entries.length, 0)

      yield* advance(Duration.minutes(1))
      assert.strictEqual(world.recording.entries.length, 1)
    })
  )

  it.effect(
    'with catch-up once, starts one run at once for times missed while closed, then keeps time from it',
    () =>
      inWorld(function* (world) {
        yield* world.provide(world.recording.queue)
        const first = yield* world.open
        yield* first.schedules.put(schedule({ catchUp: 'once' }))
        yield* advance(TEN_MINUTES)
        assert.strictEqual(world.recording.entries.length, 1)
        yield* first.close

        yield* TestClock.adjust(Duration.minutes(25))
        yield* world.open
        assert.strictEqual(world.recording.entries.length, 2)

        yield* advance(Duration.minutes(9))
        assert.strictEqual(world.recording.entries.length, 2)
        yield* advance(Duration.minutes(1))
        assert.strictEqual(world.recording.entries.length, 3)
      })
  )

  it.effect('with catch-up skip, starts nothing for missed times and waits a full interval', () =>
    inWorld(function* (world) {
      yield* world.provide(world.recording.queue)
      const first = yield* world.open
      yield* first.schedules.put(schedule({ catchUp: 'skip' }))
      yield* advance(TEN_MINUTES)
      yield* first.close

      yield* TestClock.adjust(Duration.minutes(25))
      yield* world.open
      assert.strictEqual(world.recording.entries.length, 1)

      yield* advance(Duration.minutes(9))
      assert.strictEqual(world.recording.entries.length, 1)
      yield* advance(Duration.minutes(1))
      assert.strictEqual(world.recording.entries.length, 2)
    })
  )

  it.effect('keeps the time of a schedule put again unchanged', () =>
    inWorld(function* (world) {
      yield* world.provide(world.recording.queue)
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())
      yield* advance(Duration.minutes(5))

      yield* schedules.put(schedule())
      yield* advance(Duration.minutes(5))

      assert.strictEqual(world.recording.entries.length, 1)
    })
  )

  it.effect('counts the times of a changed schedule from the change', () =>
    inWorld(function* (world) {
      yield* world.provide(world.recording.queue)
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())
      yield* advance(Duration.minutes(5))

      yield* schedules.put(schedule({ text: 'Write the summary' }))
      yield* advance(Duration.minutes(5))
      assert.strictEqual(world.recording.entries.length, 0)

      yield* advance(Duration.minutes(5))
      assert.deepStrictEqual(
        world.recording.entries.map((entry) => entry.run.text),
        ['Write the summary']
      )
    })
  )

  it.effect('starts nothing for a removed schedule', () =>
    inWorld(function* (world) {
      yield* world.provide(world.recording.queue)
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())

      yield* schedules.remove('test-report')
      yield* advance(TEN_MINUTES)

      assert.strictEqual(world.recording.entries.length, 0)
    })
  )

  it.effect('removes a schedule whose fire waits for a run queue', () =>
    inWorld(function* (world) {
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())
      yield* advance(TEN_MINUTES)

      yield* schedules.remove('test-report')
      yield* world.provide(world.recording.queue)

      assert.strictEqual(world.recording.entries.length, 0)
    })
  )

  it.effect('refuses an invalid cron expression and an unknown time zone', () =>
    inWorld(function* (world) {
      const { schedules } = yield* world.open

      const badExpression = yield* Effect.flip(
        schedules.put(schedule({ times: CronTimes.make({ expression: '0 9 * *' }) }))
      )
      const badZone = yield* Effect.flip(
        schedules.put(
          schedule({
            times: CronTimes.make({ expression: '0 9 * * *', timeZone: 'Mars/Olympus' })
          })
        )
      )

      assert.deepStrictEqual(
        [badExpression._tag, badZone._tag],
        ['InvalidSchedule', 'InvalidSchedule']
      )
    })
  )

  it.effect('refuses a cron expression that never fires and stores nothing for it', () =>
    inWorld(function* (world) {
      const first = yield* world.open

      const refused = yield* Effect.flip(
        first.schedules.put(
          schedule({ times: CronTimes.make({ expression: '0 0 30 2 *', timeZone: 'UTC' }) })
        )
      )
      yield* first.close
      const reopened = yield* Effect.exit(world.open)

      assert.strictEqual(refused._tag, 'InvalidSchedule')
      assert.isTrue(Exit.isSuccess(reopened))
    })
  )

  it.effect('starts a due run once a run queue is provided', () =>
    inWorld(function* (world) {
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())
      yield* advance(TEN_MINUTES)
      assert.strictEqual(world.recording.entries.length, 0)

      yield* world.provide(world.recording.queue)

      assert.strictEqual(world.recording.entries.length, 1)
    })
  )

  it.effect('enqueues on the next run queue after the one it used stopped', () =>
    inWorld(function* (world) {
      const stopped = yield* Deferred.make<string>()
      let stoppedCalls = 0
      yield* world.provide({
        enqueue: () => {
          stoppedCalls += 1
          return Deferred.await(stopped)
        },
        setLimit: () => Effect.void
      })
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())
      yield* advance(TEN_MINUTES)

      yield* Deferred.interrupt(stopped)
      yield* settle
      yield* world.provide(world.recording.queue)

      assert.deepStrictEqual([stoppedCalls, world.recording.entries.length], [1, 1])
    })
  )

  it.effect('reports a run that cannot start as failed and retries at the next time', () =>
    inWorld(function* (world) {
      yield* world.provide({
        enqueue: () => Effect.die(new Error('no session')),
        setLimit: () => Effect.void
      })
      const { schedules } = yield* world.open
      yield* schedules.put(schedule())

      yield* advance(TEN_MINUTES)

      const [activity] = yield* world.activities.list
      assert.strictEqual(activity?.status._tag, 'Scheduled')
      if (activity?.status._tag !== 'Scheduled') return
      assert.strictEqual(activity.status.lastRun?._tag, 'RunFailed')
      assert.strictEqual(
        DateTime.toEpochMillis(activity.status.nextRunAt),
        Duration.toMillis(Duration.minutes(20))
      )
    })
  )
})

describe('Schedule', () => {
  const encodedWith = (intervalMillis: number) => ({
    ...Schema.encodeSync(Schedule)(schedule()),
    times: { _tag: 'Interval', interval: intervalMillis }
  })

  it('accepts an interval of one second', () => {
    assert.isTrue(Exit.isSuccess(Schema.decodeUnknownExit(Schedule)(encodedWith(1000))))
  })

  it('refuses an interval under one second, or not finite', () => {
    for (const millis of [999, 0, -1000, Number.POSITIVE_INFINITY]) {
      assert.isTrue(
        Exit.isFailure(Schema.decodeUnknownExit(Schedule)(encodedWith(millis))),
        `${millis}`
      )
    }
  })
})
