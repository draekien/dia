import { ByteSize, Schema } from 'effect'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * A plugin API version as `plugin.json` declares it: `MAJOR.MINOR.PATCH`, each a non-negative
 * integer without leading zeros. Compare two versions with {@link isApiCompatible}.
 */
export const PluginApiVersion = Schema.String.check(
  Schema.isPattern(SEMVER, {
    message: 'expected a plugin API version such as "1.0.0"'
  })
)
export type PluginApiVersion = typeof PluginApiVersion.Type

/**
 * Version of the plugin API a dia build offers. A plugin manifest declares the version it was
 * written for in `api`; the loader refuses a plugin for which {@link isApiCompatible} is false.
 * While dia is in development the version stays below 0.1.0: increment the patch version on every
 * change to the plugin context, which refuses every plugin declaring an older version. From 1.0.0,
 * increment the minor version when the plugin context gains something, and the major version when
 * it changes in a way an older plugin cannot use.
 */
export const PLUGIN_API_VERSION: PluginApiVersion = '0.0.6'

const versionParts = (version: string): ReadonlyArray<number> | undefined => {
  const match = SEMVER.exec(version)
  return match === null ? undefined : match.slice(1).map(Number)
}

/**
 * Whether a plugin whose manifest declares `plugin` can load on a host that implements `host`,
 * following npm's caret rule. From 1.0.0 the major versions are equal and the plugin's minor
 * version is at most the host's. Below 1.0.0 the minor versions are equal, and below 0.1.0 the
 * patch versions are equal too. Otherwise the patch version is ignored. A value that is not
 * `MAJOR.MINOR.PATCH` is never compatible.
 */
export const isApiCompatible = (host: string, plugin: string): boolean => {
  const provided = versionParts(host)
  const required = versionParts(plugin)
  if (provided === undefined || required === undefined) return false
  const [hostMajor, hostMinor, hostPatch] = provided
  const [pluginMajor, pluginMinor, pluginPatch] = required
  if (hostMajor !== pluginMajor) return false
  if (hostMajor > 0) return pluginMinor <= hostMinor
  if (hostMinor !== pluginMinor) return false
  return hostMinor > 0 || hostPatch === pluginPatch
}

/**
 * Host heap growth, summed over a plugin's loads, at which the Host refuses to reload that plugin
 * until it restarts. `PluginInfo.memoryBytes` is measured against this value.
 */
export const PLUGIN_MEMORY_LIMIT = ByteSize.megabytes(100)

/** Formats a byte count in decimal megabytes with one decimal, for example `19.7 MB`. */
export const formatMegabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`

/** Name of a plugin: lowercase letters, digits and hyphens, starting with a letter. */
export const PluginName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
export type PluginName = typeof PluginName.Type

/**
 * When a plugin loads at startup: `eager` plugins finish loading before the Host reports ready,
 * so the first agent session can use what they provide; `lazy` plugins load in the background
 * after that.
 */
export const PluginLoadMode = Schema.Literals(['eager', 'lazy'])
export type PluginLoadMode = typeof PluginLoadMode.Type

/**
 * What a plugin is. An `adapter` translates between dia and one agent: it loads at startup from
 * the shipped copy only and is never unloaded, reloaded or overridden. A `feature` is one
 * user-facing feature and can be reloaded, unloaded and overridden.
 */
export const PluginCategory = Schema.Literals(['feature', 'adapter'])
export type PluginCategory = typeof PluginCategory.Type

/**
 * `plugin.json` of a feature plugin. `host` and `renderer` are entry paths relative to the
 * plugin directory; a plugin may declare either or both. `inject` lists the service keys the
 * plugin reads with `ctx.inject`, so the registry reopens the plugin when a provider of one of
 * them changes. `load` is the {@link PluginLoadMode} at startup; it defaults to `lazy`.
 */
export const FeatureManifest = Schema.Struct({
  name: PluginName,
  api: PluginApiVersion,
  category: Schema.Literal('feature'),
  host: Schema.optional(Schema.String),
  renderer: Schema.optional(Schema.String),
  inject: Schema.optional(Schema.Array(Schema.String)),
  load: Schema.optional(PluginLoadMode)
})
export type FeatureManifest = typeof FeatureManifest.Type

const forbidden = (message: string) => Schema.optionalKey(Schema.Never.annotate({ message }))

/**
 * `plugin.json` of an adapter plugin. `host` is its required Host entry path; an adapter has no
 * `renderer`, `inject` or `load`, and decoding a manifest that declares one fails with a message
 * that says why.
 */
export const AdapterManifest = Schema.Struct({
  name: PluginName,
  api: PluginApiVersion,
  category: Schema.Literal('adapter'),
  host: Schema.String.pipe(
    Schema.annotateKey({
      messageMissingKey: 'an adapter needs a "host" entry, because it runs in the Host'
    })
  ),
  renderer: forbidden('an adapter has no UI, so it cannot declare "renderer"'),
  inject: forbidden(
    'an adapter cannot declare "inject": a reload of the plugin it injects from would close the adapter'
  ),
  load: forbidden('an adapter always loads at startup, so it cannot declare "load"')
})
export type AdapterManifest = typeof AdapterManifest.Type

/**
 * Contents of a plugin's `plugin.json`: a {@link FeatureManifest} or an {@link AdapterManifest},
 * chosen by the required `category`. Decode it with `{ errors: 'all' }` so every problem in the
 * manifest is reported at once.
 */
export const PluginManifest = Schema.Union([FeatureManifest, AdapterManifest]).annotate({
  message: 'plugin.json must declare "category" as "feature" or "adapter"'
})
export type PluginManifest = typeof PluginManifest.Type

/** Where a plugin's code loads from: the copy shipped with dia, or a source path the user set. */
export const PluginOrigin = Schema.Literals(['default', 'override'])
export type PluginOrigin = typeof PluginOrigin.Type

/** Plugin that is not loaded and has no recorded failure. */
export const PluginUnloaded = Schema.TaggedStruct('Unloaded', {})

/**
 * Plugin whose scope is open. `reloadError` is set when the latest reload failed and the previous
 * version kept running; it is absent after a reload that succeeded.
 */
export const PluginLoaded = Schema.TaggedStruct('Loaded', {
  reloadError: Schema.optional(Schema.String)
})

/** Plugin whose last load failed; `message` is the reason. It stays unloaded until loaded again. */
export const PluginFailed = Schema.TaggedStruct('Failed', { message: Schema.String })

/** Plugin waiting for providers of the service keys in `missing` before it opens. */
export const PluginWaiting = Schema.TaggedStruct('Waiting', {
  missing: Schema.Array(Schema.String)
})

/** Why a plugin cannot reload until the Host restarts: a changed dependency outside its directory, or its memory limit. */
export const PluginRestartReason = Schema.Literals(['dependency', 'memory'])
export type PluginRestartReason = typeof PluginRestartReason.Type

/**
 * Plugin that cannot reload in this Host process for `reason`; `message` explains it. A version
 * that was running keeps running, and the plugin can still be unloaded.
 */
export const PluginRestartRequired = Schema.TaggedStruct('RestartRequired', {
  reason: PluginRestartReason,
  message: Schema.String
})

/** Plugin queued or running its first load in this Host process, with no version running yet. */
export const PluginLoading = Schema.TaggedStruct('Loading', {})

/** State of one plugin: {@link PluginUnloaded}, {@link PluginLoading}, {@link PluginLoaded}, {@link PluginFailed}, {@link PluginWaiting} or {@link PluginRestartRequired}. */
export const PluginStatus = Schema.Union([
  PluginUnloaded,
  PluginLoading,
  PluginLoaded,
  PluginFailed,
  PluginWaiting,
  PluginRestartRequired
])
export type PluginStatus = typeof PluginStatus.Type

/**
 * One row of the plugin list: a plugin's name, its {@link PluginCategory}, where it loads from
 * (`origin` and `root`), its state, `memoryBytes`, the estimated Host heap growth its loads have caused (0 on a side
 * without a memory limit), and `provides`, the service keys this plugin currently provides in the registry that built
 * the row, sorted; it is empty while the plugin is not running.
 */
export const PluginInfo = Schema.Struct({
  name: PluginName,
  category: PluginCategory,
  origin: PluginOrigin,
  root: Schema.String,
  status: PluginStatus,
  memoryBytes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  provides: Schema.Array(Schema.String)
})
export type PluginInfo = typeof PluginInfo.Type

/** Result of setting a plugin override that was saved. */
export const PluginOverrideApplied = Schema.TaggedStruct('Applied', {})

/** Result of setting a plugin override that was refused; `message` says why. Nothing was saved. */
export const PluginOverrideRejected = Schema.TaggedStruct('Rejected', { message: Schema.String })

/** Outcome of `SetPluginOverride`: {@link PluginOverrideApplied} or {@link PluginOverrideRejected}. */
export const PluginOverrideResult = Schema.Union([PluginOverrideApplied, PluginOverrideRejected])
export type PluginOverrideResult = typeof PluginOverrideResult.Type
