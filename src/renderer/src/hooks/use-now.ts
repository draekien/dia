// @effect-diagnostics globalDate:off globalTimers:off -- a React hook re-renders on a wall-clock timer; no Effect runtime exists in the renderer.
import { Duration } from 'effect'
import { useEffect, useState } from 'react'

/**
 * The current time in epoch milliseconds, refreshed every `interval`. Use it to re-render a view
 * that compares a stored time with now, such as a usage-limit reset that has passed.
 */
export function useNow(interval: Duration.Duration): number {
  const [now, setNow] = useState(() => Date.now())
  const intervalMs = Duration.toMillis(interval)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
