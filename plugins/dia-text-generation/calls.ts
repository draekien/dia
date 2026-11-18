import { EffortLevel } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** The id of this plugin, the `plugin` argument of `callHost` for its RPCs. */
export const TEXT_GENERATION_PLUGIN = 'dia-text-generation'

/** The adapter, model and effort that write a thread title. `adapter` is the id of a registered adapter; `model` is a model id of that adapter. */
export const TextGenerationSettings = Schema.Struct({
  adapter: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  effort: EffortLevel
})
/** See {@link TextGenerationSettings}. */
export type TextGenerationSettings = typeof TextGenerationSettings.Type

/** Titling a thread produced no name: no adapter offers text generation, the call failed, or the answer held no usable title. `reason` is a sentence for the log. The thread keeps its name. */
export class TitleNotGenerated extends Schema.TaggedError<TitleNotGenerated>()(
  'TitleNotGenerated',
  { reason: Schema.String }
) {}

/** The saved settings now and after each change; the defaults while nothing is saved. */
export const FollowTextGenerationSettings = Rpc.make('FollowTextGenerationSettings', {
  payload: {},
  success: TextGenerationSettings,
  stream: true
})

/** Saves the settings the next title uses. */
export const SetTextGenerationSettings = Rpc.make('SetTextGenerationSettings', {
  payload: { settings: TextGenerationSettings }
})

/** Titles thread `paneId` from its conversation so far; fails with `TitleNotGenerated` and leaves the name. */
export const RegenerateTitle = Rpc.make('RegenerateTitle', {
  payload: { paneId: Schema.String },
  error: TitleNotGenerated
})
