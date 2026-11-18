import type { ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { useCallback } from 'react'
import { useRevisionedSnapshot } from './use-revisioned-snapshot'

/** The model list a component shows and the way to re-read it; see {@link useModelCatalog}. */
export interface ModelCatalog {
  /** The newest model list state, or `undefined` until the first one arrives. */
  readonly state: ModelCatalogSnapshotJson['state'] | undefined
  /** Asks the agent to read its model list again; the outcome arrives through `state`. */
  readonly refresh: () => void
}

/**
 * Keeps the newest model list of agent adapter `adapter` (an adapter id) through
 * `window.dia.models`: it listens for changes before reading the current list, so no change is
 * missed, and keeps whichever snapshot is newest. Call it from any component that offers a model
 * choice; each caller keeps its own copy.
 */
export function useModelCatalog(adapter: string): ModelCatalog {
  const subscribe = useCallback(
    (listener: (snapshot: ModelCatalogSnapshotJson) => void) =>
      window.dia.models.onChanged(adapter, listener),
    [adapter]
  )
  const get = useCallback(() => window.dia.models.get(adapter), [adapter])
  const snapshot = useRevisionedSnapshot(subscribe, get, adapter)
  const refresh = useCallback(() => void window.dia.models.refresh(adapter), [adapter])
  return { state: snapshot?.state, refresh }
}
