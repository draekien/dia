import type { StartupLog } from '@shared/domain/startup'
import { useEffect, useState } from 'react'

const EMPTY_LOG: StartupLog = []

/**
 * The startup log of the current Host run, kept up to date while the component is mounted.
 * Subscribes before it asks main for the log so far, so a step recorded in between is not lost: a
 * pushed log always replaces the seed, and the seed is used only while no log has been pushed. A
 * seed request that fails (main has not registered its handler yet) is ignored, because the next
 * pushed log carries every step. Returns an empty log until either arrives.
 */
export function useStartupLog(): StartupLog {
  const [log, setLog] = useState<StartupLog>(EMPTY_LOG)

  useEffect(() => {
    let cancelled = false
    let receivedPush = false
    const unsubscribe = window.dia.onStartupLogChanged((pushed) => {
      receivedPush = true
      setLog(pushed)
    })
    window.dia.getStartupLog().then(
      (seed) => {
        if (!cancelled && !receivedPush) setLog(seed)
      },
      () => undefined
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return log
}
