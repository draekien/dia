import type { PluginInfo, PluginOverrideResult } from '@shared/plugin/manifest'
import { Effect } from 'effect'

/** One input field of a {@link DiaTool}: a required string the agent supplies, which must match `pattern`. */
export interface DiaToolField {
  readonly description: string
  readonly pattern: RegExp
}

/** What a {@link DiaTool} call returns to the agent. `isError` tells the agent the call did not do what it asked. */
export interface DiaToolResult {
  readonly text: string
  readonly isError: boolean
}

/**
 * A tool dia offers the agent in every session. `name` is unqualified (`plugin_reload`); the
 * agent backend exposes it under its own naming. `input` lists every field, each a required
 * string. The backend must ask the user before every call to `run`, whatever the permission
 * mode, and must not call `run` when the user declines; `run` receives input that matches every
 * field's pattern.
 */
export interface DiaTool {
  readonly name: string
  readonly description: string
  readonly input: Readonly<Record<string, DiaToolField>>
  readonly run: (input: Readonly<Record<string, string>>) => Effect.Effect<DiaToolResult>
}

/**
 * What the plugin tools can do to the Host's plugins. `reload` loads or reloads a plugin and
 * returns its resulting state; `setOverride` points a plugin at a source folder without loading
 * it; `clearOverride` returns it to the bundled copy without loading it.
 */
export interface PluginToolHost {
  readonly reload: (name: string) => Effect.Effect<PluginInfo>
  readonly setOverride: (name: string, directory: string) => Effect.Effect<PluginOverrideResult>
  readonly clearOverride: (name: string) => Effect.Effect<void>
}

const text = (value: string, isError = false): DiaToolResult => ({ text: value, isError })

const report = (info: PluginInfo): DiaToolResult => {
  const { status } = info
  switch (status._tag) {
    case 'Loaded':
      return status.reloadError === undefined
        ? text(`Plugin "${info.name}" is loaded.`)
        : text(
            `Plugin "${info.name}" kept running its previous version; the reload failed: ${status.reloadError}`,
            true
          )
    case 'Failed':
      return text(`Plugin "${info.name}" failed to load: ${status.message}`, true)
    case 'RestartRequired':
      return text(`Plugin "${info.name}" cannot reload until dia restarts: ${status.message}`, true)
    case 'Waiting':
      return text(
        `Plugin "${info.name}" is waiting for ${status.missing.join(', ')} to be provided.`,
        true
      )
    case 'Unloaded':
      return text(`Plugin "${info.name}" is not loaded.`)
    case 'Loading':
      return text(`Plugin "${info.name}" is still loading.`)
  }
}

const pluginName: DiaToolField = {
  description: 'Name of the plugin: lowercase letters, digits and hyphens.',
  pattern: /^[a-z][a-z0-9-]*$/
}

const directory: DiaToolField = {
  description: 'Absolute path of the folder holding the plugin source.',
  pattern: /[\s\S]/
}

/**
 * The three tools an agent uses to change which source a plugin loads from and to reload it:
 * `plugin_override` (set a source folder, then reload), `plugin_reload` and
 * `plugin_clear_override` (return to the bundled copy, then reload). A result with `isError` set
 * tells the agent the plugin did not end up loaded cleanly. Create them once per session and
 * pass them to the agent backend, which asks the user before each call.
 */
export const makePluginTools = (host: PluginToolHost): ReadonlyArray<DiaTool> => [
  {
    name: 'plugin_override',
    description:
      "Point a dia plugin at a source folder on disk and reload it, so the plugin runs that folder's code. The folder must hold a plugin.json and resolve to a package with type module. Asks the user to approve.",
    input: { name: pluginName, directory },
    run: Effect.fn('PluginTools.override')(function* (input) {
      const name = input.name ?? ''
      const result = yield* host.setOverride(name, input.directory ?? '')
      if (result._tag === 'Rejected') return text(`Override refused: ${result.message}`, true)
      return report(yield* host.reload(name))
    })
  },
  {
    name: 'plugin_reload',
    description:
      'Reload a dia plugin so it runs its current source. If the new version fails, the previous one keeps running and the failure is reported. Asks the user to approve.',
    input: { name: pluginName },
    run: (input) => host.reload(input.name ?? '').pipe(Effect.map(report))
  },
  {
    name: 'plugin_clear_override',
    description:
      'Return a dia plugin to the copy that ships with dia and reload it. Asks the user to approve.',
    input: { name: pluginName },
    run: Effect.fn('PluginTools.clearOverride')(function* (input) {
      const name = input.name ?? ''
      yield* host.clearOverride(name)
      return report(yield* host.reload(name))
    })
  }
]
