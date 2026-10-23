// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.
import type { PluginInfo } from '@shared/plugin/manifest'
import { useCallback, useEffect, useRef, useState } from 'react'

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
 * Drives the plugin management page through `window.dia.plugins`. The list is read on mount and
 * again after every action, because unloading or reloading one plugin can change the state of
 * the plugins that depend on it. Actions on one plugin never overlap; a second request for a
 * plugin with an action in flight is ignored.
 */
export function usePlugins(): PluginsController {
  const [plugins, setPlugins] = useState<ReadonlyArray<PluginInfo> | undefined>(undefined)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [rejection, setRejection] = useState<OverrideRejection | undefined>(undefined)
  const inFlight = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    setPlugins(await window.dia.plugins.list())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (name: string, action: () => Promise<void>) => {
      if (inFlight.current.has(name)) return
      inFlight.current.add(name)
      setPending(new Set(inFlight.current))
      setRejection((current) => (current?.name === name ? undefined : current))
      try {
        await action()
      } finally {
        await refresh()
        inFlight.current.delete(name)
        setPending(new Set(inFlight.current))
      }
    },
    [refresh]
  )

  const reload = useCallback(
    (name: string) =>
      run(name, async () => {
        await window.dia.plugins.load(name)
      }),
    [run]
  )

  const unload = useCallback(
    (name: string) =>
      run(name, async () => {
        await window.dia.plugins.unload(name)
      }),
    [run]
  )

  const chooseOverride = useCallback(
    (name: string) =>
      run(name, async () => {
        const directory = await window.dia.pickDirectory()
        if (directory === null) return
        const result = await window.dia.plugins.setOverride(name, directory)
        if (result._tag === 'Rejected') {
          setRejection({ name, message: result.message })
          return
        }
        await window.dia.plugins.load(name)
      }),
    [run]
  )

  const clearOverride = useCallback(
    (name: string) =>
      run(name, async () => {
        await window.dia.plugins.clearOverride(name)
        await window.dia.plugins.load(name)
      }),
    [run]
  )

  return { plugins, pending, rejection, reload, unload, chooseOverride, clearOverride }
}
