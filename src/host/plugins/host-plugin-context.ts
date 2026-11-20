import type { HostPluginContext as SharedHostPluginContext } from '@shared/plugin/api'
import type {
  PluginDescription,
  PluginInfo,
  PluginManifestUnreadable,
  PluginNotFound,
  PluginOverrideResult
} from '@shared/plugin/manifest'
import type { Effect } from 'effect'
import type { DiaTool } from '../session/dia-tools'

/** What a plugin's host entry can read about, and do to, the plugins the Host knows. */
export interface PluginControl {
  /** Every plugin the Host knows, as Settings › Plugins lists them. */
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  /**
   * `name`'s info with the manifest fields an author reads, read from its folder's `plugin.json`,
   * so a plugin that failed to load or never loaded can be inspected. Inspecting a plugin that
   * never loaded makes its `exports` importable by other plugins. Fails with `PluginNotFound` for
   * a name the Host does not know and `PluginManifestUnreadable` when `plugin.json` cannot be read
   * or decoded.
   */
  readonly inspect: (
    name: string
  ) => Effect.Effect<PluginDescription, PluginNotFound | PluginManifestUnreadable>
  /**
   * Points `name` at source folder `directory` without loading it, as `plugin_override` does
   * before its reload. Call `reload` afterwards to run that folder's code.
   */
  readonly setOverride: (name: string, directory: string) => Effect.Effect<PluginOverrideResult>
  /**
   * Reloads `name` in a kernel fiber the caller's interruption does not stop, and returns its
   * info after the reload. A failed reload keeps the previous version and reports it in `status`.
   * Reloading the caller's own plugin closes the caller's scope; fork that reload and do not wait.
   */
  readonly reload: (name: string) => Effect.Effect<PluginInfo>
}

/**
 * The context a plugin's `host` entry receives: the shared context (see `@shared/plugin/api`)
 * plus `pluginTools`, which returns the three `plugin_*` tools (`plugin_override`,
 * `plugin_reload`, `plugin_clear_override`), and `plugins`, the {@link PluginControl}. Register
 * the tools with the dia tool registry for run scopes. Each tool runs its plugin operation in a
 * kernel fiber the run's end does not interrupt. An operation on the calling plugin itself,
 * called from run `runId`, waits for `turnEnded(runId)`, the end of that run's current turn, and
 * its tool returns at once saying so; any other operation's tool returns its result.
 */
export interface HostPluginContext extends SharedHostPluginContext {
  readonly pluginTools: (
    turnEnded: (runId: string) => Effect.Effect<void>
  ) => ReadonlyArray<DiaTool>
  readonly plugins: PluginControl
}
