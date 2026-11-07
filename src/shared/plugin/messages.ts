import { Schema } from 'effect'
import { PluginName } from './manifest'

/**
 * Failure of a plugin call when plugin `plugin` serves no handler for `tag`: its `host` entry is
 * not loaded, does not serve `tag`, or closed during the call (the handler may then have partly
 * run). `message` says which.
 */
export class PluginNotServing extends Schema.TaggedError<PluginNotServing>()('PluginNotServing', {
  plugin: PluginName,
  tag: Schema.String,
  message: Schema.String
}) {}

/**
 * Failure of a plugin call whose payload or result did not match the call's schema on the
 * receiving side: the plugin's two entries disagree on the call, for example after only one of
 * them was reloaded. `message` gives the schema error.
 */
export class PluginCallInvalid extends Schema.TaggedError<PluginCallInvalid>()(
  'PluginCallInvalid',
  {
    plugin: PluginName,
    tag: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Wire form of a plugin handler's own typed error, encoded with the call's error schema. The
 * renderer decodes `error` back into the plugin's error; plugins never see this class.
 */
export class PluginCallFailed extends Schema.TaggedError<PluginCallFailed>()('PluginCallFailed', {
  error: Schema.Unknown
}) {}

/**
 * The JSON codec of a plugin call's payload, success or error schema: what crosses the `CallPlugin`
 * wire as `Schema.Unknown`. A call's schemas take no services.
 */
export const jsonCodec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
  Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>)

/** Every failure `CallPlugin` reports. */
export const PluginCallError = Schema.Union([PluginNotServing, PluginCallInvalid, PluginCallFailed])
export type PluginCallError = typeof PluginCallError.Type
