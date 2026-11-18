import type { ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { useEffect, useState } from 'react'

/** The model list state of one adapter as {@link useModelCatalogs} holds it. */
export type ModelCatalogStateJson = ModelCatalogSnapshotJson['state']

/**
 * Keeps the newest model list of every adapter in `adapters` through `window.dia.models`, keyed by
 * adapter id. An adapter whose first list has not arrived has no entry. Pass a list that changes
 * only when the set of adapters does; the subscriptions restart when an id is added or removed.
 */
export function useModelCatalogs(
  adapters: ReadonlyArray<{ readonly id: string }>
): ReadonlyMap<string, ModelCatalogStateJson> {
  const [held, setHeld] = useState<ReadonlyMap<string, ModelCatalogSnapshotJson>>(new Map())
  const key = adapters.map((adapter) => adapter.id).join('\n')

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribes when the set of adapter ids changes
  useEffect(() => {
    let active = true
    const keep = (id: string) => (next: ModelCatalogSnapshotJson) => {
      if (!active) return
      setHeld((current) => {
        const previous = current.get(id)
        if (previous !== undefined && previous.revision >= next.revision) return current
        return new Map(current).set(id, next)
      })
    }
    const stops = adapters.map((adapter) => {
      const stop = window.dia.models.onChanged(adapter.id, keep(adapter.id))
      void window.dia.models.get(adapter.id).then(keep(adapter.id))
      return stop
    })
    return () => {
      active = false
      for (const stop of stops) stop()
    }
  }, [key])

  const states = new Map<string, ModelCatalogStateJson>()
  for (const { id } of adapters) {
    const snapshot = held.get(id)
    if (snapshot !== undefined) states.set(id, snapshot.state)
  }
  return states
}
