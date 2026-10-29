import { useEffect, useState, useSyncExternalStore } from 'react'

interface ClockReading {
  readonly elapsedMs: number
  readonly idleMs: number
}

const TICK_MS = 1000

function createClock() {
  let turnStartMs: number | null = null
  let lastActivityMs = performance.now()
  let intervalId: number | undefined
  let reading: ClockReading = { elapsedMs: 0, idleMs: 0 }
  const listeners = new Set<() => void>()

  const publish = () => {
    const now = performance.now()
    reading = {
      elapsedMs: turnStartMs === null ? 0 : now - turnStartMs,
      idleMs: now - lastActivityMs
    }
    for (const listener of listeners) listener()
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read: () => reading,
    setRunning: (running: boolean) => {
      window.clearInterval(intervalId)
      intervalId = undefined
      turnStartMs = running ? performance.now() : null
      if (running) intervalId = window.setInterval(publish, TICK_MS)
      publish()
    },
    markActivity: () => {
      lastActivityMs = performance.now()
      publish()
    }
  }
}

/**
 * The time of a running agent turn, refreshed every second while `running` is true. `elapsedMs` is
 * the time since `running` last became true (0 while it is false). `idleMs` is the time since
 * `activitySignature` last changed; pass a string that changes whenever the turn shows new
 * activity.
 */
export function useElapsedClock(running: boolean, activitySignature: string): ClockReading {
  const [clock] = useState(createClock)

  useEffect(() => {
    clock.setRunning(running)
    return () => clock.setRunning(false)
  }, [clock, running])

  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts the idle time whenever the activity changes
  useEffect(() => clock.markActivity(), [clock, activitySignature])

  return useSyncExternalStore(clock.subscribe, clock.read)
}
