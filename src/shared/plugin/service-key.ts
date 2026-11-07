import type { AnyServiceKey } from './api'

/** The name the registry stores `key`'s service under. */
export const nameOf = (key: AnyServiceKey): string => (typeof key === 'string' ? key : key.name)

/**
 * Whether `value` may be read under `key`: always for a string key, and for a `ServiceKey` when
 * its `is` returns true. A guard that throws counts as failing.
 */
export const passes = (key: AnyServiceKey, value: unknown): boolean => {
  if (typeof key === 'string') return true
  try {
    return key.is(value)
  } catch {
    return false
  }
}
