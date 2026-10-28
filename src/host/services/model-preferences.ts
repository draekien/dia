import {
  type AdapterPreferences,
  type AgentDefaults,
  EMPTY_ADAPTER_PREFERENCES,
  keepsAModelVisible,
  LastVisibleModel,
  type ModelPreference,
  type ModelPreferencesSnapshot,
  withPreference
} from '@shared/domain/model-preferences'
import { ModelPreferencesChanged } from '@shared/ipc/contract'
import { Clock, Context, Effect, Layer, Option, Ref, Semaphore } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { EventHub } from './event-hub'
import { ModelCatalogFeed } from './model-catalog-feed'
import { SettingsStore } from './settings-store'

/**
 * The model preferences and new-agent defaults of the loaded agent adapter (the loaded plugin
 * whose category is `adapter`), stored per adapter in `SettingsStore`. `current` is empty
 * preferences when no adapter is loaded, and changes are then refused with a logged warning.
 * Changes are serialised. `set` marks a model favourite or hidden, or clears it with none; hiding
 * fails with `LastVisibleModel` when the model list is not `Ready` or when no listed model would
 * stay visible. Each change publishes `ModelPreferencesChanged`; revisions rise across Host
 * restarts. Provide it with {@link ModelPreferencesLive}.
 */
export class ModelPreferences extends Context.Service<
  ModelPreferences,
  {
    readonly current: Effect.Effect<ModelPreferencesSnapshot>
    readonly set: (
      model: string,
      preference: Option.Option<ModelPreference>
    ) => Effect.Effect<void, LastVisibleModel>
    readonly setDefaults: (defaults: AgentDefaults) => Effect.Effect<void>
  }
>()('ModelPreferences') {}

/** Live {@link ModelPreferences}. Requires `SettingsStore`, `ModelCatalogFeed`, `HostPlugins` and `EventHub`. */
export const ModelPreferencesLive = Layer.effect(
  ModelPreferences,
  Effect.gen(function* () {
    const settings = yield* SettingsStore
    const catalog = yield* ModelCatalogFeed
    const plugins = yield* HostPlugins
    const hub = yield* EventHub
    const lock = yield* Semaphore.make(1)
    const revision = yield* Ref.make(yield* Clock.currentTimeMillis)

    const adapterName = plugins
      .list()
      .pipe(
        Effect.map((infos) =>
          Option.fromUndefinedOr(
            infos.find((info) => info.category === 'adapter' && info.status._tag === 'Loaded')?.name
          )
        )
      )

    const stamp = (preferences: AdapterPreferences) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* Ref.updateAndGet(revision, (previous) => Math.max(previous + 1, now))
        return { revision: next, preferences }
      })

    const current = Effect.gen(function* () {
      const adapter = yield* adapterName
      const preferences = Option.isNone(adapter)
        ? EMPTY_ADAPTER_PREFERENCES
        : yield* settings.getAdapterPreferences(adapter.value)
      return { revision: yield* Ref.get(revision), preferences }
    })

    const change = <E>(
      description: string,
      update: (preferences: AdapterPreferences) => Effect.Effect<AdapterPreferences, E>
    ) =>
      Effect.gen(function* () {
        const adapter = yield* adapterName
        if (Option.isNone(adapter)) {
          yield* Effect.logWarning('Ignored a model preference change; no adapter is loaded', {
            change: description
          })
          return
        }
        const next = yield* update(yield* settings.getAdapterPreferences(adapter.value))
        yield* settings.setAdapterPreferences(adapter.value, next)
        const snapshot = yield* stamp(next)
        yield* hub.publish(ModelPreferencesChanged.make({ snapshot }))
        yield* Effect.logInfo('Changed model preferences', {
          adapter: adapter.value,
          change: description,
          revision: snapshot.revision
        })
      }).pipe(lock.withPermits(1))

    const set = (model: string, preference: Option.Option<ModelPreference>) =>
      change(`${model} → ${Option.getOrElse(preference, () => 'none')}`, (preferences) =>
        Effect.gen(function* () {
          const value = Option.getOrNull(preference)
          if (value === 'hidden') {
            const { state } = yield* catalog.current
            if (state._tag !== 'Ready') {
              return yield* new LastVisibleModel({
                message: 'Models cannot be hidden until the model list has loaded'
              })
            }
            if (!keepsAModelVisible(state.models, preferences, model, value)) {
              return yield* new LastVisibleModel({
                message: 'At least one model must stay visible'
              })
            }
          }
          return withPreference(preferences, model, value)
        })
      ).pipe(
        Effect.tapError((error) =>
          Effect.logInfo('Refused to hide a model', { model, reason: error.message })
        )
      )

    const setDefaults = (defaults: AgentDefaults) =>
      change('defaults', (preferences) => Effect.succeed({ ...preferences, defaults }))

    return ModelPreferences.of({ current, set, setDefaults })
  })
)
