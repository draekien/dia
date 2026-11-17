import type { AdapterStatusSnapshotJson } from '@shared/ipc/contract'
import { useCallback } from 'react'
import { useRevisionedSnapshot } from './use-revisioned-snapshot'

/** The agent adapter's install status as plain data; see {@link useAdapterStatus}. */
export type AdapterStatusJson = AdapterStatusSnapshotJson['status']

/**
 * Keeps the newest install status of agent adapter `adapter` (an adapter id) through
 * `window.dia.adapter`. Returns `undefined` until the first status arrives, and again when
 * `adapter` changes. Each caller keeps its own copy.
 */
export function useAdapterStatus(adapter: string): AdapterStatusJson | undefined {
  const subscribe = useCallback(
    (listener: (snapshot: AdapterStatusSnapshotJson) => void) =>
      window.dia.adapter.onStatusChanged(adapter, listener),
    [adapter]
  )
  const get = useCallback(() => window.dia.adapter.getStatus(adapter), [adapter])
  return useRevisionedSnapshot(subscribe, get, adapter)?.status
}
