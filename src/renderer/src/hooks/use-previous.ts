import { useState } from 'react'

export function usePrevious<T>(value: T): T | undefined {
  const [previous, setPrevious] = useState<T>()
  const [current, setCurrent] = useState<T>()

  if (value !== current) {
    setPrevious(current)
    setCurrent(value)
  }

  return previous
}
