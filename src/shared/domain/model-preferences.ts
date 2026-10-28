import { Schema } from 'effect'
import type { ModelOption } from './model'
import { StartupPermissionMode, ThinkingLevel } from './pane'

/**
 * What the user chose for one model. A model with neither preference is absent from
 * {@link AdapterPreferences.models}, so a model is never both favourite and hidden.
 */
export const ModelPreference = Schema.Literals(['favourite', 'hidden'])
export type ModelPreference = typeof ModelPreference.Type

/** The settings a new agent starts with; an absent field falls back to the app default. */
export const AgentDefaults = Schema.Struct({
  model: Schema.optional(Schema.NonEmptyString),
  thinkingLevel: Schema.optional(ThinkingLevel),
  permissionMode: Schema.optional(StartupPermissionMode)
})
export type AgentDefaults = typeof AgentDefaults.Type

/** One adapter's model preferences, keyed by `ModelOption.value`, and its defaults for new agents. */
export const AdapterPreferences = Schema.Struct({
  models: Schema.Record(Schema.String, ModelPreference),
  defaults: AgentDefaults
})
export type AdapterPreferences = typeof AdapterPreferences.Type

/** The preferences of an adapter the user has not configured. */
export const EMPTY_ADAPTER_PREFERENCES: AdapterPreferences = { models: {}, defaults: {} }

/**
 * {@link AdapterPreferences} as the renderer receives them from `GetModelPreferences` and
 * `ModelPreferencesChanged`. Keep the snapshot with the highest `revision` when a reply and an
 * event race.
 */
export const ModelPreferencesSnapshot = Schema.Struct({
  revision: Schema.Int,
  preferences: AdapterPreferences
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
