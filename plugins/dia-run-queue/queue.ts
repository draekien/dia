import { ServiceKey, type StartRunOptions } from '@dia/plugin'
import { type Effect, Predicate } from 'effect'

/**
 * A start {@link RunQueue} holds. `run` is passed to `Runs.start` when the entry starts.
 * `priority` orders entries, higher first (default 0; equal priorities start in enqueue order).
 * `key` limits how many busy runs started with `key.id` may exist when this entry starts.
 */
export interface QueuedRun {
  readonly run: StartRunOptions
  readonly priority?: number
  readonly key?: { readonly id: string; readonly limit: number }
}

/**
 * Starts runs with no tab in priority order while fewer runs than the limit are busy (see
 * `Runs.busy`: every live run counts, with or without a tab), as `dia-run-queue` provides it under
 * {@link RunQueueKey}. Read it with `ctx.whenProvided`.
 *
 * - `enqueue` queues `entry` and completes with the run's id once it started. Interrupting it
 *   before the queue picks the entry removes the entry; once picked, it waits for the start and
 *   returns the id. Entries are held in memory: when `dia-run-queue` stops, waiting calls are
 *   interrupted, so re-enqueue from the caller's own state. An answered request is never queued:
 *   the run resumes at once, ahead of every entry.
 * - `setLimit` sets how many runs may be busy before starts are held back (default 3). A limit
 *   below 1 counts as 1; a fraction is rounded down.
 */
export interface RunQueue {
  readonly enqueue: (entry: QueuedRun) => Effect.Effect<string>
  readonly setLimit: (limit: number) => Effect.Effect<void>
}

const isRunQueue = (value: unknown): value is RunQueue =>
  (['enqueue', 'setLimit'] as const).every(
    (member) => Predicate.hasProperty(value, member) && Predicate.isFunction(value[member])
  )

/**
 * The key `dia-run-queue` provides its {@link RunQueue} under: `run-queue`. A value counts when
 * `enqueue` and `setLimit` are functions.
 */
export const RunQueueKey = ServiceKey.make('run-queue', isRunQueue)
