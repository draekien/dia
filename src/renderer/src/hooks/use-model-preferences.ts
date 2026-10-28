import type { AdapterPreferences, ModelPreferencesSnapshot } from '@shared/domain/model-preferences'
import { useEffect, useState } from 'react'

const newer = (
  held: ModelPreferencesSnapshot | undefined,
  next: ModelPreferencesSnapshot
): ModelPreferencesSnapshot => (held !== undefined && held.revision >= next.revision ? held : next)

/**
 * Keeps the newest model preferences and new-agent defaults of the agent adapter through
 * `window.dia.adapter`: it listens for changes before reading the current preferences, so no
 * change is missed. Returns `undefined` until the first preferences arrive. Each caller keeps its
 * own copy.
 */
export function useModelPreferences(): AdapterPreferences | undefined {
  const [snapshot, setSnapshot] = useState<ModelPreferencesSnapshot | undefined>(undefined)

  useEffect(() => {
    let active = true
    const keep = (next: ModelPreferencesSnapshot) => {
      if (active) setSnapshot((held) => newer(held, next))
    }
    const stop = window.dia.adapter.onPreferencesChanged(keep)
    void window.dia.adapter.getPreferences().then(keep)
    return () => {
      active = false
      stop()
    }
  }, [])

  return snapshot?.preferences
}
