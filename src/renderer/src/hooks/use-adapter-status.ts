import type { AdapterStatusSnapshotJson } from '@shared/ipc/contract'
import { useRevisionedSnapshot } from './use-revisioned-snapshot'

/** The agent adapter's install status as plain data; see {@link useAdapterStatus}. */
export type AdapterStatusJson = AdapterStatusSnapshotJson['status']

/**
 * Keeps the newest agent adapter install status through `window.dia.adapter`. Returns `undefined`
 * until the first status arrives. Each caller keeps its own copy.
 */
export function useAdapterStatus(): AdapterStatusJson | undefined {
  return useRevisionedSnapshot(window.dia.adapter.onStatusChanged, window.dia.adapter.getStatus)
    ?.status
}
