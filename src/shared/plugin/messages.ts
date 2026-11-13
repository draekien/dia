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

/**
 * What a request/response handler served with `ctx.serve` receives as its second argument about
 * the call it is running. `id` identifies one `callHost` call and is the same on every resend of
 * it. `resent` is true when an earlier attempt of the call was sent; that attempt may or may not
 * have run, so a handler whose effect must apply once records `id` and returns the recorded
 * result when it sees that `id` again, and never skips work on `resent` alone.
 */
export const PluginCallAttempt = Schema.Struct({
  id: Schema.NonEmptyString,
  resent: Schema.Boolean
})
export type PluginCallAttempt = typeof PluginCallAttempt.Type

/** Every failure `CallPlugin` reports. */
export const PluginCallError = Schema.Union([PluginNotServing, PluginCallInvalid, PluginCallFailed])
export type PluginCallError = typeof PluginCallError.Type

/**
 * End of a plugin subscription whose stream failed with `error`, a {@link PluginCallError}. Sent
 * to the `onEnd` callback of `window.dia.plugins.subscribe`.
 */
export const PluginSubscriptionFailure = Schema.TaggedStruct('PluginSubscriptionFailure', {
  error: PluginCallError
})

/**
 * End of a plugin subscription whose stream completed with no failure. Sent to the `onEnd`
 * callback of `window.dia.plugins.subscribe`.
 */
export const PluginSubscriptionDone = Schema.TaggedStruct('PluginSubscriptionDone', {})

/** How a plugin subscription ended: {@link PluginSubscriptionFailure} or {@link PluginSubscriptionDone}. */
export const PluginSubscriptionEnd = Schema.Union([
  PluginSubscriptionFailure,
  PluginSubscriptionDone
])
export type PluginSubscriptionEnd = typeof PluginSubscriptionEnd.Type
