// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.
import type { PluginInfo } from '@shared/plugin/manifest'
import { useCallback, useEffect, useRef, useState } from 'react'

/** The plugin list a component shows and the way to re-read it; see {@link usePluginList}. */
export interface PluginList {
  /** Every known plugin, or `undefined` until the first list arrives. */
  readonly plugins: ReadonlyArray<PluginInfo> | undefined
  /** Reads the list from the Host now. A response that a later `refresh` overtook is discarded. */
  readonly refresh: () => Promise<void>
}

/**
 * Keeps a copy of the Host's plugin list through `window.dia.plugins`: it reads the list on mount
 * and again whenever the Host reports that a plugin changed state, so plugins appear and settle
 * one at a time while the Host loads them. Call it from any component that shows plugin state;
 * each caller keeps its own copy.
 */
export function usePluginList(): PluginList {
  const [plugins, setPlugins] = useState<ReadonlyArray<PluginInfo> | undefined>(undefined)
  const latestRequest = useRef(0)

  const refresh = useCallback(async () => {
    latestRequest.current += 1
    const request = latestRequest.current
    const next = await window.dia.plugins.list()
    if (request === latestRequest.current) setPlugins(next)
  }, [])

  useEffect(() => {
    void refresh()
    return window.dia.plugins.onStatusChanged(() => void refresh())
  }, [refresh])

  return { plugins, refresh }
}
