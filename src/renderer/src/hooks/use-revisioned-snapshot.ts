import { useEffect, useState } from 'react'

/**
 * Keeps the newest of a Host snapshot that carries a `revision`: it calls `subscribe` before
 * `get`, so no change between the two is missed, and keeps whichever snapshot has the higher
 * revision when a reply and an event race. Returns `undefined` until the first snapshot arrives.
 * Pass stable functions (the `window.dia` methods, bound to their arguments in a `useCallback` that
 * changes only with `key`); they are read on mount and again when `key` changes, which drops the
 * held snapshot.
 */
export function useRevisionedSnapshot<S extends { readonly revision: number }>(
  subscribe: (listener: (snapshot: S) => void) => () => void,
  get: () => Promise<S>,
  key: string = ''
): S | undefined {
  const [held, setHeld] = useState<{ readonly key: string; readonly snapshot: S } | undefined>(
    undefined
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribes on mount and when `key` changes
  useEffect(() => {
    let active = true
    const keep = (next: S) => {
      if (active) {
        setHeld((current) =>
          current !== undefined && current.key === key && current.snapshot.revision >= next.revision
            ? current
            : { key, snapshot: next }
        )
      }
    }
    const stop = subscribe(keep)
    void get().then(keep)
    return () => {
      active = false
      stop()
    }
  }, [key])

  return held?.key === key ? held.snapshot : undefined
}
