import { Schema, SchemaTransformation } from 'effect'
import { LEGACY_ADAPTER_ID } from './legacy-adapter'
import type { ModelOption } from './model'
import { StartupPermissionMode, ThinkingLevel } from './pane'

/**
 * What the user chose for one model. A model with neither preference is absent from
 * {@link AdapterPreferences.models}, so a model is never both favourite and hidden.
 */
export const ModelPreference = Schema.Literals(['favourite', 'hidden'])
export type ModelPreference = typeof ModelPreference.Type

/**
 * A model of one adapter. `backend` is an adapter id (the adapter plugin's name) and `model` is a
 * `ModelOption.value` from that adapter's catalog. Every model choice (new-thread default, job
 * title, schedule) takes this form so no adapter interprets a model it was not chosen from.
 */
export const ModelSelection = Schema.Struct({
  backend: Schema.NonEmptyString,
  model: Schema.NonEmptyString
})
export type ModelSelection = typeof ModelSelection.Type

/**
 * The settings a new run starts with; an absent field falls back to `Runs.defaultSelection` or the
 * app default. Pass it to `SetAgentDefaults` and read it from {@link ModelPreferences.defaults}.
 */
export const AgentDefaults = Schema.Struct({
  selection: Schema.optional(ModelSelection),
  thinkingLevel: Schema.optional(ThinkingLevel),
  permissionMode: Schema.optional(StartupPermissionMode)
})
export type AgentDefaults = typeof AgentDefaults.Type

/** Favourite and hidden models of one adapter, keyed by `ModelOption.value`. */
export const AdapterPreferences = Schema.Struct({
  models: Schema.Record(Schema.String, ModelPreference)
})
export type AdapterPreferences = typeof AdapterPreferences.Type

/** The preferences of an adapter the user has not configured. */
export const EMPTY_ADAPTER_PREFERENCES: AdapterPreferences = { models: {} }

/**
 * Every adapter's favourite and hidden models, keyed by adapter id, and the defaults for new runs.
 * Read one adapter's entry with {@link adapterPreferencesOf}.
 */
export const ModelPreferences = Schema.Struct({
  adapters: Schema.Record(Schema.String, AdapterPreferences),
  defaults: AgentDefaults
})
export type ModelPreferences = typeof ModelPreferences.Type

/** The preferences of a user who has configured nothing. */
export const EMPTY_MODEL_PREFERENCES: ModelPreferences = { adapters: {}, defaults: {} }

/** The preferences of adapter `adapter` in `preferences`, or {@link EMPTY_ADAPTER_PREFERENCES} when it has none. */
export const adapterPreferencesOf = (
  preferences: ModelPreferences,
  adapter: string
): AdapterPreferences => preferences.adapters[adapter] ?? EMPTY_ADAPTER_PREFERENCES

const LegacyShape = Schema.Struct({
  models: Schema.Record(Schema.String, ModelPreference),
  defaults: Schema.Struct({
    model: Schema.optional(Schema.NonEmptyString),
    thinkingLevel: Schema.optional(ThinkingLevel),
    permissionMode: Schema.optional(StartupPermissionMode)
  })
})

/**
 * The shape stored before adapters existed, `{ models, defaults: { model?, thinkingLevel?,
 * permissionMode? } }`, decoded into {@link ModelPreferences} under {@link LEGACY_ADAPTER_ID}.
 * Use it to read `settings.json`; prefer {@link StoredModelPreferences} for stored data of either
 * shape.
 */
export const LegacyModelPreferences = LegacyShape.pipe(
  Schema.decodeTo(
    ModelPreferences,
    SchemaTransformation.transform<ModelPreferences, typeof LegacyShape.Type>({
      decode: ({ models, defaults: { model, ...rest } }) => ({
        adapters: { [LEGACY_ADAPTER_ID]: { models } },
        defaults: {
          ...rest,
          ...(model === undefined ? {} : { selection: { backend: LEGACY_ADAPTER_ID, model } })
        }
      }),
      encode: ({ adapters, defaults: { selection, ...rest } }) => ({
        models: adapters[LEGACY_ADAPTER_ID]?.models ?? {},
        defaults: {
          ...rest,
          ...(selection?.backend === LEGACY_ADAPTER_ID ? { model: selection.model } : {})
        }
      })
    })
  )
)

/**
 * Decodes the stored preferences of either shape (new first) and encodes the new one. Use it to
 * read and write the `modelPreferences` setting.
 */
export const StoredModelPreferences = Schema.Union([ModelPreferences, LegacyModelPreferences])

/**
 * {@link ModelPreferences} as the renderer receives them from `GetModelPreferences` and
 * `ModelPreferencesChanged`. Keep the snapshot with the highest `revision` when a reply and an
 * event race.
 */
export const ModelPreferencesSnapshot = Schema.Struct({
  revision: Schema.Int,
  preferences: ModelPreferences
})
export type ModelPreferencesSnapshot = typeof ModelPreferencesSnapshot.Type

/** The refusal message when hiding a model would leave none visible; also the hide toggle's tooltip. */
export const LAST_VISIBLE_MODEL_MESSAGE = 'At least one model must stay visible'

/**
 * `SetModelPreference` refused to hide a model: no listed model would stay visible, or the model
 * list is not known yet. `message` is shown to the user.
 */
export class LastVisibleModel extends Schema.TaggedError<LastVisibleModel>()('LastVisibleModel', {
  message: Schema.String
}) {}

/**
 * The models a model picker lists, in catalog order: `favourites`, then `others` (neither
 * favourite nor hidden). When every model is hidden, `others` is every model, so a picker is never
 * empty while the catalog is not.
 */
export const pickerModels = <M extends ModelOption>(
  models: ReadonlyArray<M>,
  preferences: AdapterPreferences
): { readonly favourites: ReadonlyArray<M>; readonly others: ReadonlyArray<M> } => {
  const favourites = models.filter((model) => preferences.models[model.value] === 'favourite')
  const others = models.filter((model) => preferences.models[model.value] === undefined)
  if (favourites.length === 0 && others.length === 0) return { favourites, others: models }
  return { favourites, others }
}

/**
 * Whether setting `model` to `preference` (none clears it) leaves at least one of `models`
 * visible. Use it before hiding a model.
 */
export const keepsAModelVisible = (
  models: ReadonlyArray<ModelOption>,
  preferences: AdapterPreferences,
  model: string,
  preference: ModelPreference | null
): boolean => {
  const next = withPreference(preferences, model, preference)
  return models.some((option) => next.models[option.value] !== 'hidden')
}

/** `preferences` with `model` set to `preference`, or cleared when `preference` is null. */
export const withPreference = (
  preferences: AdapterPreferences,
  model: string,
  preference: ModelPreference | null
): AdapterPreferences => {
  const { [model]: _previous, ...rest } = preferences.models
  return { ...preferences, models: preference === null ? rest : { ...rest, [model]: preference } }
}
