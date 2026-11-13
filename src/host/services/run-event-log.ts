import { emptyPaneChatState } from '@shared/domain/pane-chat'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Context, Deferred, Effect, Layer, Option, Stream } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import {
  type AppendEntry,
  type RecordingOptions,
  ReloadRequired,
  type ReplayLimits,
  type RunEvents,
  RunEventsKey,
  RunEventWriteError
} from './run-events-seam'

const NOT_LOADED = 'The dia-run-events plugin is not loaded'

/**
 * The run event log the loaded `dia-run-events` plugin provides, for kernel code that still runs
 * tab sessions. Each member delegates to the provider loaded at the time of the call; `committed`
 * follows the provider across reloads. With no provider: `append` fails with
 * `RunEventWriteError`, `readAfter` returns `ReloadRequired('readFailed')`, `record` records nothing, `snapshot` returns the empty state at sequence 0, and
 * `seed` and `release` do nothing; each logs why. `hostStartSequence` is the `startSequence` of the
 * first provider this Host saw, and waits for one. Provide it with {@link RunEventLogLive}.
 */
export class RunEventLog extends Context.Service<
  RunEventLog,
  Omit<RunEvents, 'startSequence' | 'highestSequence' | 'subscribe'> & {
    readonly hostStartSequence: Effect.Effect<number>
  }
>()('RunEventLog') {}

/**
 * Where {@link RunEventLog} finds the plugin registry without depending on `HostPlugins`, which
 * depends on `EventHub`, which depends on {@link RunEventLog}. {@link RunEventLogConnectLive}
 * completes it. Build {@link RunEventLogRegistryLive} once per Host and provide it to both.
 */
export class RunEventLogRegistry extends Context.Service<
  RunEventLogRegistry,
  Deferred.Deferred<Pick<PluginRegistry, 'inject' | 'changes'>>
>()('RunEventLogRegistry') {}

/** Builds an empty {@link RunEventLogRegistry}. */
export const RunEventLogRegistryLive = Layer.effect(
  RunEventLogRegistry,
  Deferred.make<Pick<PluginRegistry, 'inject' | 'changes'>>()
)

/** Completes {@link RunEventLogRegistry} with `HostPlugins`. Requires both. */
export const RunEventLogConnectLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const holder = yield* RunEventLogRegistry
    yield* Deferred.succeed(holder, yield* HostPlugins)
  })
)

/** The live {@link RunEventLog}. Requires {@link RunEventLogRegistry}. */
export const RunEventLogLive = Layer.effect(
  RunEventLog,
  Effect.gen(function* () {
    const holder = yield* RunEventLogRegistry
    const firstStart = yield* Deferred.make<number>()

    const current = Effect.gen(function* () {
      const registry = yield* Deferred.await(holder)
      // biome-ignore lint/plugin/noRegistryInject: a recording runs in the session's scope for its whole life, which a `use` lease would hold open across a reload (docs/designs/dia-run-events.md D6)
      const provided = yield* registry.inject(RunEventsKey)
      if (Option.isSome(provided)) {
        yield* Deferred.succeed(firstStart, provided.value.startSequence)
      }
      return provided
    })

    const withProvider = <A>(
      name: string,
      fallback: Effect.Effect<A>,
      run: (events: RunEvents) => Effect.Effect<A>
    ) =>
      Effect.flatMap(
        current,
        Option.match({
          onSome: run,
          onNone: () =>
            Effect.logWarning(`${NOT_LOADED}; ${name} did nothing`).pipe(Effect.andThen(fallback))
        })
      )

    const providers = Stream.unwrap(
      Effect.map(Deferred.await(holder), (registry) =>
        Stream.merge(
          Stream.make(RunEventsKey.name),
          registry.changes.pipe(Stream.filter((key) => key === RunEventsKey.name))
        )
      )
    ).pipe(
      Stream.mapEffect(() => current),
      Stream.tap((provided) =>
        Effect.logInfo('Following the run event log provider', { loaded: Option.isSome(provided) })
      )
    )

    return RunEventLog.of({
      append: (runId: string, events: ReadonlyArray<AppendEntry>) =>
        Effect.flatMap(
          current,
          Option.match({
            onSome: (provider) => provider.append(runId, events),
            onNone: () => Effect.fail(new RunEventWriteError({ cause: NOT_LOADED }))
          })
        ),
      committed: providers.pipe(
        Stream.switchMap(
          Option.match({ onNone: () => Stream.empty, onSome: (provider) => provider.committed })
        )
      ),
      readAfter: (runId: string, afterSequence: number, limits: ReplayLimits) =>
        withProvider(
          'readAfter',
          Effect.succeed(ReloadRequired.make({ reason: 'readFailed' })),
          (p) => p.readAfter(runId, afterSequence, limits)
        ),
      hostStartSequence: Deferred.await(firstStart),
      record: (options: RecordingOptions) =>
        Effect.flatMap(current, (provided) =>
          Option.isSome(provided)
            ? provided.value.record(options)
            : Effect.logError(`${NOT_LOADED}; the session is not recorded`, {
                runId: options.runId
              }).pipe(Effect.as(() => Effect.void))
        ),
      snapshot: (runId: string) =>
        withProvider('snapshot', Effect.succeed({ state: emptyPaneChatState, seq: 0 }), (p) =>
          p.snapshot(runId)
        ),
      seed: (runId: string) => withProvider('seed', Effect.void, (p) => p.seed(runId)),
      release: (runId: string) => withProvider('release', Effect.void, (p) => p.release(runId))
    })
  })
)
