import { DEFAULT_UPDATE_STATUS, type UpdateStatus } from '@shared/domain/update'
import { useEffect, useState } from 'react'

/**
 * Tracks the app's background self-update status for the current session.
 * Subscribes first, then seeds from the main process, so a late seed can't
 * clobber a fresher pushed event. Returns the current {@link UpdateStatus} for
 * rendering the header indicator and the About dialog's update line.
 */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>(DEFAULT_UPDATE_STATUS)

  useEffect(() => {
    let cancelled = false
    let receivedEvent = false
    const unsubscribe = window.dia.onUpdateStatusChanged((event) => {
      receivedEvent = true
      if (!cancelled) setStatus(event.status)
    })
    window.dia.getUpdateStatus().then((seed) => {
      if (!cancelled && !receivedEvent) setStatus(seed)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return status
}
