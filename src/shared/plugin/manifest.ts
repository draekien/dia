import { Schema } from 'effect'

/**
 * Version of the plugin API a dia build offers. A plugin manifest declares the version it was
 * written for in `api`; the loader refuses a plugin whose `api` differs from this value.
 * Increment it whenever the context a plugin receives changes in a way an older plugin cannot use.
 */
export const PLUGIN_API_VERSION = '1'

/** Name of a plugin: lowercase letters, digits and hyphens, starting with a letter. */
export const PluginName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
export type PluginName = typeof PluginName.Type

/**
 * Contents of a plugin's `plugin.json`. `host` and `renderer` are entry paths relative to the
 * plugin directory; a plugin may declare either or both. `inject` lists the service keys the
 * plugin reads with `ctx.inject`, so the registry reopens the plugin when a provider of one of
 * them changes.
 */
export const PluginManifest = Schema.Struct({
  name: PluginName,
  api: Schema.String,
  host: Schema.optional(Schema.String),
  renderer: Schema.optional(Schema.String),
  inject: Schema.optional(Schema.Array(Schema.String))
})
export type PluginManifest = typeof PluginManifest.Type

/** Where a plugin's code loads from: the copy shipped with dia, or a source path the user set. */
export const PluginOrigin = Schema.Literals(['default', 'override'])
export type PluginOrigin = typeof PluginOrigin.Type

/** Plugin that is not loaded and has no recorded failure. */
export const PluginUnloaded = Schema.TaggedStruct('Unloaded', {})

/** Plugin whose scope is open. */
export const PluginLoaded = Schema.TaggedStruct('Loaded', {})

/** Plugin whose last load failed; `message` is the reason. It stays unloaded until loaded again. */
export const PluginFailed = Schema.TaggedStruct('Failed', { message: Schema.String })

/** Plugin waiting for providers of the service keys in `missing` before it opens. */
export const PluginWaiting = Schema.TaggedStruct('Waiting', {
  missing: Schema.Array(Schema.String)
})

/** State of one plugin: {@link PluginUnloaded}, {@link PluginLoaded}, {@link PluginFailed} or {@link PluginWaiting}. */
export const PluginStatus = Schema.Union([
  PluginUnloaded,
  PluginLoaded,
  PluginFailed,
  PluginWaiting
])
export type PluginStatus = typeof PluginStatus.Type

/** One row of the plugin list: a plugin's name, where it loads from, and its state. */
export const PluginInfo = Schema.Struct({
  name: PluginName,
  origin: PluginOrigin,
  status: PluginStatus
})
export type PluginInfo = typeof PluginInfo.Type

/** Result of setting a plugin override that was saved. */
export const PluginOverrideApplied = Schema.TaggedStruct('Applied', {})

/** Result of setting a plugin override that was refused; `message` says why. Nothing was saved. */
export const PluginOverrideRejected = Schema.TaggedStruct('Rejected', { message: Schema.String })

/** Outcome of `SetPluginOverride`: {@link PluginOverrideApplied} or {@link PluginOverrideRejected}. */
export const PluginOverrideResult = Schema.Union([PluginOverrideApplied, PluginOverrideRejected])
export type PluginOverrideResult = typeof PluginOverrideResult.Type
