import type { AdapterStatusSnapshotJson } from '@shared/ipc/contract'
import { useEffect, useState } from 'react'

/** The agent adapter's install status as plain data; see {@link useAdapterStatus}. */
export type AdapterStatusJson = AdapterStatusSnapshotJson['status']

const newer = (
  held: AdapterStatusSnapshotJson | undefined,
  next: AdapterStatusSnapshotJson
): AdapterStatusSnapshotJson => (held !== undefined && held.revision >= next.revision ? held : next)

/**
 * Keeps the newest agent adapter install status through `window.dia.adapter`: it listens for
 * changes before reading the current status, so no change is missed. Returns `undefined` until
 * the first status arrives. Each caller keeps its own copy.
 */
export function useAdapterStatus(): AdapterStatusJson | undefined {
  const [snapshot, setSnapshot] = useState<AdapterStatusSnapshotJson | undefined>(undefined)

  useEffect(() => {
    let active = true
    const keep = (next: AdapterStatusSnapshotJson) => {
      if (active) setSnapshot((held) => newer(held, next))
    }
    const stop = window.dia.adapter.onStatusChanged(keep)
    void window.dia.adapter.getStatus().then(keep)
    return () => {
      active = false
      stop()
    }
  }, [])

  return snapshot?.status
}
