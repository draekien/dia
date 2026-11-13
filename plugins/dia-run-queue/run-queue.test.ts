import type { Runs, StartRunOptions } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import type { QueuedRun } from './queue'
import { makeRunQueue } from './run-queue'

const SETTLE = Duration.millis(50)

const runNamed = (name: string): StartRunOptions => ({
  cwd: name,
  model: 'm',
  thinkingLevel: 'adaptive',
  permissionMode: 'default',
  text: 'work'
})

const queued = (name: string, extra: Omit<QueuedRun, 'run'> = {}): QueuedRun => ({
  run: runNamed(name),
  ...extra
})

const makeWorld = (initiallyBusy: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const busy = yield* SubscriptionRef.make<ReadonlyArray<string>>(initiallyBusy)
    const started: Array<string> = []
    const nothing = () => Effect.void
    const runs: Runs = {
      open: () => Effect.die('not used'),
      start: (options) =>
        Effect.gen(function* () {
          started.push(options.cwd)
          yield* SubscriptionRef.update(busy, (current) => [...current, options.cwd])
          return options.cwd
        }),
      send: nothing,
      editQueued: nothing,
      removeQueued: nothing,
      sendQueuedNow: nothing,
      answer: nothing,
      requests: Stream.make([]),
      busy: SubscriptionRef.changes(busy),
      interrupt: nothing,
      resumeParked: nothing,
      rewind: nothing,
      setThinkingLevel: nothing,
      setPermissionMode: nothing,
      setModel: nothing,
      awaitIdle: nothing,
      isLive: () => Effect.succeed(true),
      close: nothing,
      retire: nothing,
      list: Effect.succeed([]),
      openInTab: nothing,
      changes: Stream.empty,
      discoverSessions: () => Effect.succeed([])
    }
    const provider = yield* SubscriptionRef.make(Option.none<Runs>())
    const queue = yield* makeRunQueue(provider)
    const leaveBusy = (runId: string) =>
      SubscriptionRef.update(busy, (current) => current.filter((id) => id !== runId))
    const becomeBusy = (runId: string) =>
      SubscriptionRef.update(busy, (current) => [...current, runId])
    const provide = SubscriptionRef.set(provider, Option.some(runs))
    const startedOnce = (count: number) =>
      Effect.suspend(() =>
        started.length >= count ? Effect.succeed([...started]) : Effect.fail('waiting')
      ).pipe(
        Effect.retry({ times: 200, schedule: Schedule.spaced(Duration.millis(5)) }),
        Effect.orElseSucceed(() => [...started])
      )
    const settled = Effect.sleep(SETTLE).pipe(Effect.andThen(Effect.sync(() => [...started])))
    return { queue, provide, leaveBusy, becomeBusy, startedOnce, settled }
  })

describe('run queue', () => {
  it.live('starts a queued run when a busy run starts waiting for the user (limit 2)', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld()
      yield* world.queue.setLimit(2)
      yield* world.provide
      yield* Effect.forEach(['a', 'b', 'c'], (name) =>
        Effect.forkChild(world.queue.enqueue(queued(name)))
      )
      const beforeWaiting = yield* world.startedOnce(2).pipe(Effect.andThen(world.settled))

      yield* world.leaveBusy('a')

      assert.deepStrictEqual(
        [beforeWaiting, yield* world.startedOnce(3)],
        [
          ['a', 'b'],
          ['a', 'b', 'c']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.live('starts the third queued run when one of two turns ends (limit 2)', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld()
      yield* world.queue.setLimit(2)
      const third = yield* Effect.forEach(['a', 'b', 'c'], (name) =>
        Effect.forkChild(world.queue.enqueue(queued(name)))
      ).pipe(Effect.map((fibers) => fibers[2]))
      yield* world.provide
      const whileBothRun = yield* world.startedOnce(2).pipe(Effect.andThen(world.settled))

      yield* world.leaveBusy('b')

      assert.deepStrictEqual(
        [whileBothRun, third === undefined ? '' : yield* Fiber.join(third)],
        [['a', 'b'], 'c']
      )
    }).pipe(Effect.scoped)
  )

  it.live('keeps a second run with the same key queued under a key limit of 1', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld()
      yield* world.queue.setLimit(3)
      const hire = { id: 'hire-1', limit: 1 }
      yield* Effect.forkChild(world.queue.enqueue(queued('a', { key: hire })))
      yield* Effect.forkChild(world.queue.enqueue(queued('b', { key: hire })))
      yield* Effect.forkChild(world.queue.enqueue(queued('c')))
      yield* world.provide
      const whileFirstRuns = yield* world.startedOnce(2).pipe(Effect.andThen(world.settled))

      yield* world.leaveBusy('a')

      assert.deepStrictEqual(
        [whileFirstRuns, yield* world.startedOnce(3)],
        [
          ['a', 'c'],
          ['a', 'c', 'b']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.live('resumes an answered run ahead of a queued run (limit 1)', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld()
      yield* world.queue.setLimit(1)
      yield* world.provide
      yield* world.queue.enqueue(queued('a'))
      yield* world.leaveBusy('a')
      yield* world.queue.enqueue(queued('b'))
      yield* Effect.forkChild(world.queue.enqueue(queued('c')))
      yield* world.becomeBusy('a')

      yield* world.leaveBusy('b')
      const whileAnsweredRuns = yield* world.settled
      yield* world.leaveBusy('a')

      assert.deepStrictEqual(
        [whileAnsweredRuns, yield* world.startedOnce(3)],
        [
          ['a', 'b'],
          ['a', 'b', 'c']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.live('starts the higher-priority run first when a slot frees', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(['busy'])
      yield* world.queue.setLimit(1)
      yield* world.provide
      yield* Effect.forkChild(world.queue.enqueue(queued('low', { priority: 0 })))
      yield* Effect.forkChild(world.queue.enqueue(queued('high', { priority: 5 })))
      yield* world.settled

      yield* world.leaveBusy('busy')

      assert.deepStrictEqual(yield* world.startedOnce(1).pipe(Effect.andThen(world.settled)), [
        'high'
      ])
    }).pipe(Effect.scoped)
  )

  it.live('removes an entry whose caller stops waiting before it starts', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(['busy'])
      yield* world.queue.setLimit(1)
      yield* world.provide
      const abandoned = yield* Effect.forkChild(world.queue.enqueue(queued('abandoned')))
      yield* Effect.forkChild(world.queue.enqueue(queued('kept')))
      yield* world.settled
      yield* Fiber.interrupt(abandoned)

      yield* world.leaveBusy('busy')

      assert.deepStrictEqual(yield* world.startedOnce(1).pipe(Effect.andThen(world.settled)), [
        'kept'
      ])
    }).pipe(Effect.scoped)
  )

  it.live('interrupts a waiting enqueue when the queue closes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const world = yield* makeWorld().pipe(Scope.provide(scope))
      const waiting = yield* Effect.forkChild(world.queue.enqueue(queued('a')))
      yield* world.settled

      yield* Scope.close(scope, Exit.void)

      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(waiting)))
    })
  )
})
