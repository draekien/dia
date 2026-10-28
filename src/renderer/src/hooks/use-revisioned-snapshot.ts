import { useEffect, useState } from 'react'

/**
 * Keeps the newest of a Host snapshot that carries a `revision`: it calls `subscribe` before
 * `get`, so no change between the two is missed, and keeps whichever snapshot has the higher
 * revision when a reply and an event race. Returns `undefined` until the first snapshot arrives.
 * Pass stable functions (the `window.dia` methods); they are read once, on mount.
 */
export function useRevisionedSnapshot<S extends { readonly revision: number }>(
  subscribe: (listener: (snapshot: S) => void) => () => void,
  get: () => Promise<S>
): S | undefined {
  const [snapshot, setSnapshot] = useState<S | undefined>(undefined)

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribes once, on mount
  useEffect(() => {
    let active = true
    const keep = (next: S) => {
      if (active) {
        setSnapshot((held) => (held !== undefined && held.revision >= next.revision ? held : next))
      }
    }
    const stop = subscribe(keep)
    void get().then(keep)
    return () => {
      active = false
      stop()
    }
  }, [])

  return snapshot
}
