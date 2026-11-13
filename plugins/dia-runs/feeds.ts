import {
  type AdapterStatusSnapshot,
  HealthNotChecked,
  type ModelCatalogSnapshot,
  ModelPreferences,
  ModelsLoading
} from '@dia/plugin'
import { Clock, Effect, Option, Semaphore, Stream, SubscriptionRef } from 'effect'
import type { AgentBackend } from './backend'
import type { RunRows } from './run-rows'

/** The settings key the loaded adapter's model preferences are stored under. */
export const PREFERENCES_KEY = 'modelPreferences'

const nextRevision = (previous: number, now: number) => Math.max(previous + 1, now)

/**
 * The model list, adapter status and model preferences the renderer shows, read from the backend
 * `backends` emits now and after each change of adapter. Each snapshot's revision rises across
 * restarts. `models.refresh`, `status.check` and `status.setInstallPath` act on the current
 * backend; `preferences.set` refuses to hide a model with `LastVisibleModel` when the list has not
 * loaded or no listed model would stay visible. The forwarding fibers live in the calling scope.
 */
export const makeFeeds = Effect.fn('Feeds.make')(function* (deps: {
  readonly backends: Stream.Stream<AgentBackend>
  readonly backend: Effect.Effect<AgentBackend>
  readonly rows: RunRows
}) {
  const now = yield* Clock.currentTimeMillis
  const models = yield* SubscriptionRef.make<ModelCatalogSnapshot>({
    revision: 0,
    state: ModelsLoading.make({})
  })
  const status = yield* SubscriptionRef.make<AdapterStatusSnapshot>({
    revision: 0,
    status: { health: HealthNotChecked.make({}), checking: false, installPathOverride: null }
  })
  const stored = yield* deps.rows.getSetting(PREFERENCES_KEY, ModelPreferences.AdapterPreferences)
  const preferences = yield* SubscriptionRef.make<ModelPreferences.ModelPreferencesSnapshot>({
    revision: now,
    preferences: Option.getOrElse(stored, () => ModelPreferences.EMPTY_ADAPTER_PREFERENCES)
  })
  const lock = yield* Semaphore.make(1)

  yield* deps.backends.pipe(
    Stream.switchMap((backend) => backend.models()),
    Stream.runForEach((state) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const next = yield* SubscriptionRef.updateAndGet(models, (previous) => ({
          revision: nextRevision(previous.revision, at),
          state
        }))
        yield* Effect.logInfo('Model list changed', { state: state._tag, revision: next.revision })
      })
    ),
    Effect.forkScoped
  )
  yield* deps.backends.pipe(
    Stream.switchMap((backend) => backend.status()),
    Stream.runForEach((current) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const next = yield* SubscriptionRef.updateAndGet(status, (previous) => ({
          revision: nextRevision(previous.revision, at),
          status: current
        }))
        yield* Effect.logInfo('Adapter status changed', {
          health: current.health._tag,
          checking: current.checking,
          revision: next.revision
        })
      })
    ),
    Effect.forkScoped
  )

  const changePreferences = <E>(
    description: string,
    update: (
      current: ModelPreferences.AdapterPreferences
    ) => Effect.Effect<ModelPreferences.AdapterPreferences, E>
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(preferences)
        const next = yield* update(current.preferences)
        yield* deps.rows.setSetting(PREFERENCES_KEY, ModelPreferences.AdapterPreferences, next)
        const at = yield* Clock.currentTimeMillis
        const snapshot = { revision: nextRevision(current.revision, at), preferences: next }
        yield* SubscriptionRef.set(preferences, snapshot)
        yield* Effect.logInfo('Changed model preferences', {
          change: description,
          revision: snapshot.revision
        })
      })
    )

  const setPreference = (
    model: string,
    preference: Option.Option<ModelPreferences.ModelPreference>
  ) =>
    changePreferences(`${model} → ${Option.getOrElse(preference, () => 'none')}`, (current) =>
      Effect.gen(function* () {
        const value = Option.getOrNull(preference)
        if (value === 'hidden') {
          const { state } = yield* SubscriptionRef.get(models)
          if (state._tag !== 'Ready') {
            return yield* new ModelPreferences.LastVisibleModel({
              message: 'Models cannot be hidden until the model list has loaded'
            })
          }
          if (!ModelPreferences.keepsAModelVisible(state.models, current, model, value)) {
            return yield* new ModelPreferences.LastVisibleModel({
              message: ModelPreferences.LAST_VISIBLE_MODEL_MESSAGE
            })
          }
        }
        return ModelPreferences.withPreference(current, model, value)
      })
    ).pipe(
      Effect.tapError((error) =>
        Effect.logInfo('Refused to hide a model', { model, reason: error.message })
      )
    )

  return {
    models: {
      current: SubscriptionRef.get(models),
      changes: SubscriptionRef.changes(models),
      refresh: Effect.flatMap(deps.backend, (backend) => backend.refreshModels())
    },
    status: {
      current: SubscriptionRef.get(status),
      changes: SubscriptionRef.changes(status),
      check: Effect.flatMap(deps.backend, (backend) => backend.checkHealth()),
      setInstallPath: (path: string | null) =>
        Effect.flatMap(deps.backend, (backend) =>
          backend.setInstallPath(Option.fromNullishOr(path))
        )
    },
    preferences: {
      current: SubscriptionRef.get(preferences),
      changes: SubscriptionRef.changes(preferences),
      set: setPreference,
      setDefaults: (defaults: ModelPreferences.AgentDefaults) =>
        changePreferences('defaults', (current) => Effect.succeed({ ...current, defaults }))
    }
  }
})
