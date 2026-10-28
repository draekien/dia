import { type AdapterStatusSnapshot, HealthNotChecked } from '@shared/domain/adapter-status'
import { AdapterStatusChanged } from '@shared/ipc/contract'
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  type Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { resolveAgentBackend } from '../session/agent-backend'
import { EventHub } from './event-hub'

/**
 * The agent adapter's install status for the renderer. Call `start` once, after the agent
 * adapter has loaded and before the Host reports ready: it reads the adapter's first status, then
 * keeps forwarding every later status, each published as an `AdapterStatusChanged` event.
 * `current` is the latest snapshot (`HealthNotChecked` before `start`); `check` asks the adapter
 * to re-check its install and completes when that check ends; `setInstallPath` stores or clears
 * where the adapter finds its install, then re-checks. Revisions rise across Host restarts.
 * Provide it with {@link AdapterStatusFeedLive}. Mirrors `ModelCatalogFeed`.
 */
export class AdapterStatusFeed extends Context.Service<
  AdapterStatusFeed,
  {
    readonly start: Effect.Effect<void>
    readonly current: Effect.Effect<AdapterStatusSnapshot>
    readonly check: Effect.Effect<void>
    readonly setInstallPath: (path: string | null) => Effect.Effect<void>
  }
>()('AdapterStatusFeed') {}

/** Live {@link AdapterStatusFeed}. Requires `HostPlugins` and `EventHub`; its forwarding fiber lives as long as the layer. */
export const AdapterStatusFeedLive = Layer.effect(
  AdapterStatusFeed,
  Effect.gen(function* () {
    const plugins = yield* HostPlugins
    const hub = yield* EventHub
    const scope: Scope.Scope = yield* Effect.scope
    const snapshot = yield* SubscriptionRef.make<AdapterStatusSnapshot>({
      revision: 0,
      status: { health: HealthNotChecked.make({}), checking: false, installPathOverride: null }
    })

    const publish = (status: AdapterStatusSnapshot['status']) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* SubscriptionRef.modify(snapshot, (previous) => {
          const updated = { revision: Math.max(previous.revision + 1, now), status }
          return [updated, updated] as const
        })
        yield* hub.publish(AdapterStatusChanged.make({ snapshot: next }))
        yield* Effect.logInfo('Adapter status changed', {
          health: status.health._tag,
          checking: status.checking,
          revision: next.revision
        })
      })

    const start = Effect.gen(function* () {
      const backend = yield* resolveAgentBackend(plugins)
      const firstPublished = yield* Deferred.make<void>()
      yield* backend.status().pipe(
        Stream.runForEach((status) =>
          publish(status).pipe(Effect.andThen(Deferred.succeed(firstPublished, undefined)))
        ),
        Effect.ensuring(Deferred.succeed(firstPublished, undefined)),
        Effect.forkIn(scope)
      )
      yield* Deferred.await(firstPublished)
    })

    return AdapterStatusFeed.of({
      start,
      current: SubscriptionRef.get(snapshot),
      check: resolveAgentBackend(plugins).pipe(Effect.flatMap((backend) => backend.checkHealth())),
      setInstallPath: (path) =>
        resolveAgentBackend(plugins).pipe(
          Effect.flatMap((backend) => backend.setInstallPath(Option.fromNullishOr(path)))
        )
    })
  })
)
