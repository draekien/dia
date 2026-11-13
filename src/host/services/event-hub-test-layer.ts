import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { runEventsMigrations } from '../../../plugins/dia-run-events/migrations'
import { RunEventStore, RunEventStoreLive } from '../../../plugins/dia-run-events/store'
import { openDatabase } from './database'
import { type EventHub, EventHubLive } from './event-hub'
import { RunEventLog } from './run-event-log'

/**
 * The `dia-run-events` store and the `SqlClient` it writes, over an in-memory database that is
 * discarded with the layer. Each build starts with no stored events.
 */
export const RunEventStoreTestLayer: Layer.Layer<RunEventStore | SqlClient.SqlClient> =
  Layer.provideMerge(
    RunEventStoreLive,
    Layer.effect(SqlClient.SqlClient, openDatabase(':memory:', runEventsMigrations))
  ).pipe(Layer.orDie)

/**
 * A {@link RunEventLog} over the provided store. Its `record` records nothing, `snapshot` dies,
 * and `seed` and `release` do nothing; `hostStartSequence` is the store's highest sequence when
 * the layer is built.
 */
export const RunEventLogFromStore: Layer.Layer<RunEventLog, never, RunEventStore> = Layer.effect(
  RunEventLog,
  Effect.gen(function* () {
    const store = yield* RunEventStore
    const start = yield* store.highestSequence.pipe(Effect.orElseSucceed(() => 0))
    return RunEventLog.of({
      append: store.append,
      committed: store.committed,
      readAfter: store.readAfter,
      hostStartSequence: Effect.succeed(start),
      record: () => Effect.succeed(() => Effect.void),
      snapshot: () => Effect.die('RunEventLogTestLayer.snapshot is not implemented'),
      seed: () => Effect.void,
      release: () => Effect.void
    })
  })
)

/** {@link RunEventLogFromStore} over {@link RunEventStoreTestLayer}. */
export const RunEventLogTestLayer: Layer.Layer<RunEventLog | RunEventStore | SqlClient.SqlClient> =
  Layer.provideMerge(RunEventLogFromStore, RunEventStoreTestLayer)

/**
 * The live {@link EventHub} with the in-memory store it stores pane events in. For tests that need
 * a real hub; each build starts with no stored events.
 */
export const EventHubTestLayer: Layer.Layer<
  EventHub | RunEventLog | RunEventStore | SqlClient.SqlClient
> = Layer.provideMerge(EventHubLive, RunEventLogTestLayer)
