import type { Runs } from '@dia/plugin'
import {
  Deferred,
  Effect,
  Exit,
  Option,
  Queue,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import { type PickEntry, pickStarts } from './pick'
import type { QueuedRun, RunQueue } from './queue'

const DEFAULT_LIMIT = 3

interface Waiting extends PickEntry {
  readonly started: Deferred.Deferred<string>
}

const startsAtLeastOne = (limit: number) => Math.max(1, Math.floor(limit) || 1)

/**
 * Builds the {@link RunQueue} `dia-run-queue` provides, in the calling scope. `runs` holds the
 * current run service, or none while `dia-runs` is not loaded: entries wait until one is
 * provided, and keep their place across a reload of `dia-runs`. Closing the scope interrupts
 * every waiting `enqueue`.
 */
export const makeRunQueue = Effect.fn('RunQueue.make')(function* (
  runs: SubscriptionRef.SubscriptionRef<Option.Option<Runs>>
): Effect.fn.Return<RunQueue, never, Scope.Scope> {
  const entries = yield* Ref.make<ReadonlyArray<Waiting>>([])
  const keyOf = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
  const limit = yield* Ref.make(DEFAULT_LIMIT)
  const wake = yield* Queue.sliding<void>(1)
  const trigger = Queue.offer(wake, undefined).pipe(Effect.asVoid)

  const startEntry = (provided: Runs, waiting: Waiting) =>
    provided.start(waiting.entry.run).pipe(
      Effect.tap((runId) => {
        const key = waiting.entry.key
        return key === undefined
          ? Effect.void
          : Ref.update(keyOf, (current) => new Map(current).set(runId, key.id))
      }),
      Effect.tap((runId) =>
        Effect.logInfo('Started a queued run', { runId, key: waiting.entry.key?.id })
      ),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(waiting.started, exit)),
      Effect.onInterrupt(() => Deferred.interrupt(waiting.started))
    )

  const pass = Effect.gen(function* () {
    const provided = yield* SubscriptionRef.get(runs)
    if (Option.isNone(provided)) {
      return yield* Effect.logDebug('No run service; queued runs wait')
    }
    const busy = new Set(Option.getOrElse(yield* Stream.runHead(provided.value.busy), () => []))
    const input = { limit: yield* Ref.get(limit), busy, keyOf: yield* Ref.get(keyOf) }
    const [picks, held] = yield* Ref.modify(entries, (queued) => {
      const picked = pickStarts({ ...input, queued })
      const remaining = queued.filter((waiting) => !picked.includes(waiting))
      return [[picked, remaining.length] as const, remaining]
    })
    yield* Effect.logDebug('Run queue pass', {
      busy: busy.size,
      limit: input.limit,
      starting: picks.length,
      held
    })
    yield* Effect.forEach(picks, (waiting) => startEntry(provided.value, waiting), {
      discard: true
    })
  })

  yield* Queue.take(wake).pipe(Effect.andThen(pass), Effect.forever, Effect.forkScoped)
  yield* SubscriptionRef.changes(runs).pipe(
    Stream.switchMap(
      Option.match({ onNone: () => Stream.make([]), onSome: (provided) => provided.busy })
    ),
    Stream.runForEach(() => trigger),
    Effect.forkScoped
  )
  yield* Effect.addFinalizer(() =>
    Ref.getAndSet(entries, []).pipe(
      Effect.flatMap((waiting) =>
        Effect.forEach(waiting, ({ started }) => Deferred.interrupt(started), { discard: true })
      )
    )
  )

  const removeIfQueued = (waiting: Waiting) =>
    Ref.modify(entries, (queued) =>
      queued.includes(waiting)
        ? [true, queued.filter((other) => other !== waiting)]
        : [false, queued]
    )

  const enqueue = (entry: QueuedRun) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const waiting: Waiting = {
          entry,
          started: yield* Deferred.make<string>()
        }
        yield* Ref.update(entries, (queued) => [...queued, waiting])
        yield* Effect.logInfo('Queued a run', {
          priority: entry.priority ?? 0,
          key: entry.key?.id,
          cwd: entry.run.cwd
        })
        yield* trigger
        const exit = yield* Effect.exit(restore(Deferred.await(waiting.started)))
        if (Exit.isSuccess(exit) || !Exit.hasInterrupts(exit)) return yield* exit
        if (yield* removeIfQueued(waiting)) {
          yield* Effect.logInfo('Removed a queued run whose caller stopped waiting', {
            key: entry.key?.id
          })
          return yield* exit
        }
        return yield* Deferred.await(waiting.started)
      })
    )

  const setLimit = (value: number) => {
    const next = startsAtLeastOne(value)
    return Ref.set(limit, next).pipe(
      Effect.andThen(Effect.logInfo('Set the run queue limit', { limit: next })),
      Effect.andThen(trigger)
    )
  }

  return { enqueue, setLimit }
})
