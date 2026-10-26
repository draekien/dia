import { type ModelCatalogSnapshot, ModelsLoading } from '@shared/domain/model'
import { ModelsChanged } from '@shared/ipc/contract'
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  type Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { resolveAgentBackend } from '../session/agent-backend'
import { EventHub } from './event-hub'

/**
 * The model list for the renderer. Call `start` once, after the agent adapter has loaded and
 * before the Host reports ready: it reads the adapter's first model state, then keeps forwarding
 * every later state, each published as a `ModelsChanged` event. `current` is the latest
 * snapshot (`Loading` with revision 0 before `start`); `refresh` asks the adapter to re-read the
 * list and completes when that read ends. Revisions rise across Host restarts, so the renderer
 * can keep the newest of a reply and an event. Provide it with {@link ModelCatalogFeedLive}.
 */
export class ModelCatalogFeed extends Context.Service<
  ModelCatalogFeed,
  {
    readonly start: Effect.Effect<void>
    readonly current: Effect.Effect<ModelCatalogSnapshot>
    readonly refresh: Effect.Effect<void>
  }
>()('ModelCatalogFeed') {}

/** Live {@link ModelCatalogFeed}. Requires `HostPlugins` and `EventHub`; its forwarding fiber lives as long as the layer. */
export const ModelCatalogFeedLive = Layer.effect(
  ModelCatalogFeed,
  Effect.gen(function* () {
    const plugins = yield* HostPlugins
    const hub = yield* EventHub
    const scope: Scope.Scope = yield* Effect.scope
    const snapshot = yield* SubscriptionRef.make<ModelCatalogSnapshot>({
      revision: 0,
      state: ModelsLoading.make({})
    })

    const publish = (state: ModelCatalogSnapshot['state']) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* SubscriptionRef.modify(snapshot, (previous) => {
          const updated = { revision: Math.max(previous.revision + 1, now), state }
          return [updated, updated] as const
        })
        yield* hub.publish(ModelsChanged.make({ snapshot: next }))
        yield* Effect.logInfo('Model list changed', {
          state: state._tag,
          revision: next.revision
        })
      })

    const start = Effect.gen(function* () {
      const backend = yield* resolveAgentBackend(plugins)
      const firstPublished = yield* Deferred.make<void>()
      yield* backend.models().pipe(
        Stream.runForEach((state) =>
          publish(state).pipe(Effect.andThen(Deferred.succeed(firstPublished, undefined)))
        ),
        Effect.ensuring(Deferred.succeed(firstPublished, undefined)),
        Effect.forkIn(scope)
      )
      yield* Deferred.await(firstPublished)
    })

    return ModelCatalogFeed.of({
      start,
      current: SubscriptionRef.get(snapshot),
      refresh: resolveAgentBackend(plugins).pipe(
        Effect.flatMap((backend) => backend.refreshModels())
      )
    })
  })
)
