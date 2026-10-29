import { useState } from 'react'

/**
 * The value `value` had before it last changed, compared with `!==`; `undefined` until it has
 * changed once. It stays the same across renders that pass an unchanged `value`.
 */
export function usePrevious<T>(value: T): T | undefined {
  const [previous, setPrevious] = useState<T>()
  const [current, setCurrent] = useState<T>()

  if (value !== current) {
    setPrevious(current)
    setCurrent(value)
  }

  return previous
}
