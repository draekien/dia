import {
  type AdapterStatusSnapshot,
  HealthNotChecked,
  type ModelCatalogSnapshot,
  ModelsLoading,
  type PermissionMode
} from '@dia/plugin'
import { Clock, Effect, Exit, Option, Scope, Stream, SubscriptionRef } from 'effect'
import {
  type AgentBackend,
  agentBackendProblems,
  isAgentBackend,
  unavailableBackend
} from './backend'
import { type AgentAdapter, type AgentAdapters, notLoadedMessage } from './registry'

interface Registration {
  readonly adapter: AgentAdapter
  readonly models: SubscriptionRef.SubscriptionRef<ModelCatalogSnapshot>
  readonly status: SubscriptionRef.SubscriptionRef<AdapterStatusSnapshot>
}

const nextRevision = (previous: number, now: number) => Math.max(previous + 1, now)

const byLabelThenId = (left: AgentAdapter, right: AgentAdapter) =>
  left.label.localeCompare(right.label) || left.id.localeCompare(right.id)

/**
 * Builds the adapter registry: the {@link AgentAdapters} service, and the per-adapter feeds and
 * actions `dia-agent-adapters` serves to the renderer. Each registration holds one revision-stamped
 * model feed and one status feed, stopped when the registration ends. An id that is not registered
 * answers as `unavailableBackend(notLoadedMessage(id))` answers. Call it once per host entry.
 */
export const makeAgentAdapterRegistry = Effect.fn('AgentAdapterRegistry.make')(function* () {
  const registrations = yield* SubscriptionRef.make<ReadonlyMap<string, Registration>>(new Map())

  const backendOf = (id: string): Effect.Effect<AgentBackend> =>
    Effect.map(
      SubscriptionRef.get(registrations),
      (current) => current.get(id)?.adapter.backend ?? unavailableBackend(notLoadedMessage(id))
    )

  const startRegistration = Effect.fn('AgentAdapterRegistry.startRegistration')(function* (
    adapter: AgentAdapter,
    feedScope: Scope.Scope
  ) {
    const now = yield* Clock.currentTimeMillis
    const models = yield* SubscriptionRef.make<ModelCatalogSnapshot>({
      revision: now,
      state: ModelsLoading.make({})
    })
    const status = yield* SubscriptionRef.make<AdapterStatusSnapshot>({
      revision: now,
      status: { health: HealthNotChecked.make({}), checking: false, installPathOverride: null }
    })
    yield* adapter.backend.models().pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const next = yield* SubscriptionRef.updateAndGet(models, (previous) => ({
            revision: nextRevision(previous.revision, at),
            state
          }))
          yield* Effect.logInfo('Model list changed', {
            adapter: adapter.id,
            state: state._tag,
            revision: next.revision
          })
        })
      ),
      Effect.forkIn(feedScope)
    )
    yield* adapter.backend.status().pipe(
      Stream.runForEach((current) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const next = yield* SubscriptionRef.updateAndGet(status, (previous) => ({
            revision: nextRevision(previous.revision, at),
            status: current
          }))
          yield* Effect.logInfo('Adapter status changed', {
            adapter: adapter.id,
            health: current.health._tag,
            checking: current.checking,
            revision: next.revision
          })
        })
      ),
      Effect.forkIn(feedScope)
    )
    return { adapter, models, status } satisfies Registration
  })

  const register: AgentAdapters['register'] = (ctx, { label, backend }) =>
    Effect.gen(function* () {
      if (!isAgentBackend(backend)) {
        return yield* Effect.logError('An adapter was not registered; its backend is invalid', {
          adapter: ctx.name,
          problems: agentBackendProblems(Option.some(backend))
        })
      }
      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const feedScope = yield* Scope.make()
          const registration = yield* startRegistration({ id: ctx.name, label, backend }, feedScope)
          const replaced = yield* SubscriptionRef.modify(registrations, (current) => [
            current.get(ctx.name),
            new Map(current).set(ctx.name, registration)
          ])
          if (replaced !== undefined) {
            yield* Effect.logWarning(
              'An adapter registered again and replaced its earlier registration',
              {
                adapter: ctx.name
              }
            )
          }
          yield* Effect.logInfo('An adapter was registered', { adapter: ctx.name })
          return { registration, feedScope }
        }),
        ({ registration, feedScope }) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.update(registrations, (current) => {
              if (current.get(ctx.name) !== registration) return current
              const next = new Map(current)
              next.delete(ctx.name)
              return next
            })
            yield* Scope.close(feedScope, Exit.void)
            yield* Effect.logInfo('An adapter was unregistered', { adapter: ctx.name })
          })
      )
    })

  const registered = Stream.map(SubscriptionRef.changes(registrations), (current) =>
    [...current.values()].map((registration) => registration.adapter).sort(byLabelThenId)
  )

  const feedOf = <A>(
    id: string,
    pick: (registration: Registration) => SubscriptionRef.SubscriptionRef<A>,
    absent: Stream.Stream<A>
  ) =>
    SubscriptionRef.changes(registrations).pipe(
      Stream.map((current) => current.get(id)),
      Stream.changesWith((left, right) => left === right),
      Stream.switchMap((registration) =>
        registration === undefined ? absent : SubscriptionRef.changes(pick(registration))
      )
    )

  const modelSnapshots = (id: string) =>
    feedOf(
      id,
      (registration) => registration.models,
      Stream.unwrap(
        Effect.gen(function* () {
          const revision = yield* Clock.currentTimeMillis
          return Stream.map(
            unavailableBackend(notLoadedMessage(id)).models(),
            (state): ModelCatalogSnapshot => ({ revision, state })
          )
        })
      )
    )

  const statusSnapshots = (id: string) =>
    feedOf(
      id,
      (registration) => registration.status,
      Stream.unwrap(
        Effect.gen(function* () {
          const revision = yield* Clock.currentTimeMillis
          return Stream.map(
            unavailableBackend(notLoadedMessage(id)).status(),
            (status): AdapterStatusSnapshot => ({ revision, status })
          )
        })
      )
    )

  const first = <A>(snapshots: Stream.Stream<A>) =>
    snapshots.pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow))

  const service: AgentAdapters = {
    register,
    adapters: registered,
    get: (id) =>
      Effect.map(SubscriptionRef.get(registrations), (current) =>
        Option.fromNullishOr(current.get(id)?.adapter)
      ),
    models: (id) => Stream.map(modelSnapshots(id), (snapshot) => snapshot.state)
  }

  return {
    service,
    summaries: Stream.map(registered, (adapters) =>
      adapters.map(({ id, label }) => ({ id, label }))
    ),
    models: {
      current: (id: string) => first(modelSnapshots(id)),
      changes: modelSnapshots,
      refresh: (id: string) => Effect.flatMap(backendOf(id), (backend) => backend.refreshModels())
    },
    status: {
      current: (id: string) => first(statusSnapshots(id)),
      changes: statusSnapshots,
      check: (id: string) => Effect.flatMap(backendOf(id), (backend) => backend.checkHealth()),
      setInstallPath: (id: string, path: string | null) =>
        Effect.flatMap(backendOf(id), (backend) =>
          backend.setInstallPath(Option.fromNullishOr(path))
        )
    },
    disabledPermissionModes: (
      id: string,
      cwd: string
    ): Effect.Effect<ReadonlyArray<PermissionMode>> =>
      Effect.flatMap(backendOf(id), (backend) => backend.disabledPermissionModes(cwd)),
    attachmentTypes: (id: string) =>
      Effect.flatMap(backendOf(id), (backend) => backend.attachmentTypes())
  }
})
