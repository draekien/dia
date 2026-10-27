// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.
import type { ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { useCallback, useEffect, useState } from 'react'

/** The model list a component shows and the way to re-read it; see {@link useModelCatalog}. */
export interface ModelCatalog {
  /** The newest model list state, or `undefined` until the first one arrives. */
  readonly state: ModelCatalogSnapshotJson['state'] | undefined
  /** Asks the agent to read its model list again; the outcome arrives through `state`. */
  readonly refresh: () => void
}

const newer = (
  held: ModelCatalogSnapshotJson | undefined,
  next: ModelCatalogSnapshotJson
): ModelCatalogSnapshotJson => (held !== undefined && held.revision >= next.revision ? held : next)

/**
 * Keeps the newest model list through `window.dia.models`: it listens for changes before reading
 * the current list, so no change is missed, and keeps whichever snapshot is newest. Call it from
 * any component that offers a model choice; each caller keeps its own copy.
 */
export function useModelCatalog(): ModelCatalog {
  const [snapshot, setSnapshot] = useState<ModelCatalogSnapshotJson | undefined>(undefined)

  useEffect(() => {
    let active = true
    const keep = (next: ModelCatalogSnapshotJson) => {
      if (active) setSnapshot((held) => newer(held, next))
    }
    const stop = window.dia.models.onChanged(keep)
    void window.dia.models.get().then(keep)
    return () => {
      active = false
      stop()
    }
  }, [])

  const refresh = useCallback(() => void window.dia.models.refresh(), [])

  return { state: snapshot?.state, refresh }
}
