import { Schema } from 'effect'
import { EffortLevel } from './pane'

export const ModelSupportedFeature = Schema.Literals([
  'effort levels',
  'auto mode',
  'fast mode',
  'adaptive thinking'
])
export type ModelSupportedFeature = typeof ModelSupportedFeature.Type

/**
 * A model a new agent can use, as the agent reports it. Pass `value` unchanged as the `model` of
 * a new tab; show `displayName`, with `description` as supporting text. `adaptiveThinking` says
 * whether the model can think adaptively, and `effortLevels` lists the efforts it can cap that
 * thinking at (empty when it supports none).
 */
export const ModelOption = Schema.Struct({
  value: Schema.NonEmptyString,
  displayName: Schema.NonEmptyString,
  description: Schema.String,
  adaptiveThinking: Schema.Boolean,
  effortLevels: Schema.Array(EffortLevel),
  supportedFeatures: Schema.Array(ModelSupportedFeature)
})
export type ModelOption = typeof ModelOption.Type

/** No model list is known yet; the first read is due or running. */
export const ModelsLoading = Schema.TaggedStruct('Loading', {})
export type ModelsLoading = typeof ModelsLoading.Type

/**
 * No model list is known: `message` says why the last read failed, and `refreshing` is true while
 * a new read runs.
 */
export const ModelsUnavailable = Schema.TaggedStruct('Unavailable', {
  message: Schema.String,
  refreshing: Schema.Boolean
})
export type ModelsUnavailable = typeof ModelsUnavailable.Type

/**
 * A model list read at `fetchedAt`. `refreshing` is true while a new read runs;
 * `lastRefreshError` is set when the latest read failed, so this list is older than that read.
 */
export const ModelsReady = Schema.TaggedStruct('Ready', {
  models: Schema.NonEmptyArray(ModelOption),
  fetchedAt: Schema.DateTimeUtcFromString,
  refreshing: Schema.Boolean,
  lastRefreshError: Schema.optional(Schema.String)
})
export type ModelsReady = typeof ModelsReady.Type

/** The model list as the agent adapter reports it: {@link ModelsLoading}, {@link ModelsUnavailable} or {@link ModelsReady}. */
export const ModelCatalogState = Schema.Union([ModelsLoading, ModelsUnavailable, ModelsReady])
export type ModelCatalogState = typeof ModelCatalogState.Type

/**
 * A {@link ModelCatalogState} as the renderer receives it from `GetModels` and `ModelsChanged`.
 * A snapshot with a higher `revision` is newer, also across Host restarts, so keep the one with
 * the highest revision when a reply and an event race.
 */
export const ModelCatalogSnapshot = Schema.Struct({
  revision: Schema.Int,
  state: ModelCatalogState
})
export type ModelCatalogSnapshot = typeof ModelCatalogSnapshot.Type
