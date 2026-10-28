import { Effect } from 'effect'
import { useCallback, useState, useSyncExternalStore } from 'react'

type ElapsedClockStore = {
  subscribe: (listener: () => void, running: boolean, activitySignature: string) => () => void
  getSnapshot: () => number
  getServerSnapshot: () => number
  getElapsedMs: () => number
  getIdleMs: () => number
}

function createElapsedClockStore(): ElapsedClockStore {
  let clockMs = 0
  let turnStartMs: number | null = null
  let lastActivityMs = 0
  let running = false
  let activitySignature = ''

  let intervalId: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<() => void>()

  function notify() {
    listeners.forEach((listener) => void listener())
  }

  function stopTimer() {
    if (intervalId === undefined) return

    clearInterval(intervalId)
    intervalId = undefined
  }

  function syncInputs(nextRunning: boolean, nextActivitySignature: string) {
    const now = performance.now()
    let changed = false

    if (nextRunning !== running) {
      running = nextRunning
      turnStartMs = running ? now : null
      clockMs = now
      changed = true
    }

    if (nextActivitySignature !== activitySignature) {
      activitySignature = nextActivitySignature
      lastActivityMs = now
      clockMs = now
      changed = true
    }

    if (running && listeners.size > 0 && intervalId === undefined) {
      // @effect-diagnostics-next-line globalTimers:off - need to confirm if effect works here first
      intervalId = setInterval(() => {
        clockMs = performance.now()
        notify()
      }, 1000)
    } else if (!running) {
      stopTimer()
    }

    return changed
  }

  return {
    getSnapshot: () => clockMs,

    getServerSnapshot: () => 0,

    getElapsedMs: () => (turnStartMs === null ? 0 : clockMs - turnStartMs),

    getIdleMs: () => clockMs - lastActivityMs,

    subscribe(listener, nextRunning, nextActivitySignature) {
      syncInputs(nextRunning, nextActivitySignature)
      listeners.add(listener)

      if (running && intervalId === undefined) {
        // @effect-diagnostics-next-line globalTimers:off - need to confirm if effect works here first
        intervalId = setInterval(() => {
          clockMs = performance.now()
          notify()
        }, 1000)
      }

      return () => {
        listeners.delete(listener)

        if (listeners.size === 0) stopTimer()
      }
    }
  }
}

export function useElapsedClock(running: boolean, activitySignature: string) {
  const [store] = useState(createElapsedClockStore)

  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener, running, activitySignature),
    [store, running, activitySignature]
  )

  const clockMs = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot)

  return {
    clockMs,
    elapsedMs: store.getElapsedMs(),
    idleMs: store.getIdleMs()
  }
}
