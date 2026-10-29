// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.
import type { PluginInfo } from '@shared/plugin/manifest'
import { useRef, useState } from 'react'
import { usePluginList } from './use-plugin-list'

/** An override the Host refused, kept until the user acts on that plugin again. */
export interface OverrideRejection {
  readonly name: string
  readonly message: string
}

/** State and actions of the plugin management page; see {@link usePlugins}. */
export interface PluginsController {
  /** Every known plugin, or `undefined` until the first list arrives. */
  readonly plugins: ReadonlyArray<PluginInfo> | undefined
  /** Names of plugins with an action in flight. */
  readonly pending: ReadonlySet<string>
  /** The latest refused override, if any. */
  readonly rejection: OverrideRejection | undefined
  /** Loads the plugin, or reloads it when it is open. */
  readonly reload: (name: string) => Promise<void>
  /** Closes the plugin. */
  readonly unload: (name: string) => Promise<void>
  /** Asks for a folder, points the plugin at it and reloads. Does nothing when the picker is cancelled. */
  readonly chooseOverride: (name: string) => Promise<void>
  /** Returns the plugin to the copy shipped with dia and reloads. */
  readonly clearOverride: (name: string) => Promise<void>
}

/**
 * Drives the plugin management page through `window.dia.plugins`. The list follows the Host's
 * state changes (see {@link usePluginList}) and is read again after every action, because
 * unloading or reloading one plugin can change the state of the plugins that depend on it.
 * Actions on one plugin never overlap; a second request for a plugin with an action in flight is
 * ignored.
 */
export function usePlugins(): PluginsController {
  const { plugins, refresh } = usePluginList()
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [rejection, setRejection] = useState<OverrideRejection | undefined>(undefined)
  const inFlight = useRef(new Set<string>())

  const run = async (name: string, action: () => Promise<void>) => {
    if (inFlight.current.has(name)) return
    inFlight.current.add(name)
    setPending(new Set(inFlight.current))
    setRejection((current) => (current?.name === name ? undefined : current))
    try {
      await action()
    } catch (error) {
      setRejection({ name, message: error instanceof Error ? error.message : String(error) })
    } finally {
      inFlight.current.delete(name)
      setPending(new Set(inFlight.current))
      await refresh().catch(() => undefined)
    }
  }

  const reload = (name: string) =>
    run(name, async () => {
      await window.dia.plugins.load(name)
    })

  const unload = (name: string) =>
    run(name, async () => {
      await window.dia.plugins.unload(name)
    })

  const chooseOverride = (name: string) =>
    run(name, async () => {
      const directory = await window.dia.pickDirectory()
      if (directory === null) return
      const result = await window.dia.plugins.setOverride(name, directory)
      if (result._tag === 'Rejected') {
        setRejection({ name, message: result.message })
        return
      }
      await window.dia.plugins.load(name)
    })

  const clearOverride = (name: string) =>
    run(name, async () => {
      await window.dia.plugins.clearOverride(name)
      await window.dia.plugins.load(name)
    })

  return { plugins, pending, rejection, reload, unload, chooseOverride, clearOverride }
}
