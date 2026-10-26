// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.
import type { ActivityInfoJson } from '@shared/ipc/contract'
import { useCallback, useEffect, useRef, useState } from 'react'

/** The background activities a component shows and the way to run one; see {@link useActivities}. */
export interface Activities {
  /** Every registered background activity, or `undefined` until the first list arrives. */
  readonly activities: ReadonlyArray<ActivityInfoJson> | undefined
  /** Runs activity `id` of `plugin` now; its progress arrives through `activities`. */
  readonly run: (plugin: string, id: string) => void
}

/**
 * Keeps a copy of the Host's background activity list through `window.dia.activities`: it reads
 * the list on mount and again whenever an activity is registered, removed, starts or finishes.
 */
export function useActivities(): Activities {
  const [activities, setActivities] = useState<ReadonlyArray<ActivityInfoJson> | undefined>(
    undefined
  )
  const latestRequest = useRef(0)

  const refresh = useCallback(async () => {
    latestRequest.current += 1
    const request = latestRequest.current
    const next = await window.dia.activities.list()
    if (request === latestRequest.current) setActivities(next)
  }, [])

  useEffect(() => {
    void refresh()
    return window.dia.activities.onChanged(() => void refresh())
  }, [refresh])

  const run = useCallback((plugin: string, id: string) => {
    void window.dia.activities.run(plugin, id)
  }, [])

  return { activities, run }
}
