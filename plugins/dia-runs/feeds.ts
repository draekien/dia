import { type ModelCatalogState, ModelPreferences } from '@dia/plugin'
import { Clock, Effect, Option, Semaphore, SubscriptionRef } from 'effect'
import type { RunRows } from './run-rows'

/** The settings key the loaded adapter's model preferences are stored under. */
export const PREFERENCES_KEY = 'modelPreferences'

const nextRevision = (previous: number, now: number) => Math.max(previous + 1, now)

/**
 * The model preferences the renderer shows. Each snapshot's revision rises across restarts.
 * `preferences.set` refuses to hide a model with `LastVisibleModel` when the model list `models`
 * reads for the adapter has not loaded or no listed model would stay visible.
 */
export const makeFeeds = Effect.fn('Feeds.make')(function* (deps: {
  readonly models: (adapter: string) => Effect.Effect<ModelCatalogState>
  readonly rows: RunRows
}) {
  const now = yield* Clock.currentTimeMillis
  const stored = yield* deps.rows.getSetting(PREFERENCES_KEY, ModelPreferences.AdapterPreferences)
  const preferences = yield* SubscriptionRef.make<ModelPreferences.ModelPreferencesSnapshot>({
    revision: now,
    preferences: Option.getOrElse(stored, () => ModelPreferences.EMPTY_ADAPTER_PREFERENCES)
  })
  const lock = yield* Semaphore.make(1)

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
    adapter: string,
    model: string,
    preference: Option.Option<ModelPreferences.ModelPreference>
  ) =>
    changePreferences(`${model} → ${Option.getOrElse(preference, () => 'none')}`, (current) =>
      Effect.gen(function* () {
        const value = Option.getOrNull(preference)
        if (value === 'hidden') {
          const state = yield* deps.models(adapter)
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
        Effect.logInfo('Refused to hide a model', { adapter, model, reason: error.message })
      )
    )

  return {
    preferences: {
      current: SubscriptionRef.get(preferences),
      changes: SubscriptionRef.changes(preferences),
      set: setPreference,
      setDefaults: (defaults: ModelPreferences.AgentDefaults) =>
        changePreferences('defaults', (current) => Effect.succeed({ ...current, defaults }))
    }
  }
})
