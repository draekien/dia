import type { AdapterPreferences } from '@shared/domain/model-preferences'
import { useRevisionedSnapshot } from './use-revisioned-snapshot'

/**
 * Keeps the newest model preferences and new-agent defaults of the agent adapter through
 * `window.dia.adapter`. Returns `undefined` until the first preferences arrive. Each caller keeps
 * its own copy.
 */
export function useModelPreferences(): AdapterPreferences | undefined {
  return useRevisionedSnapshot(
    window.dia.adapter.onPreferencesChanged,
    window.dia.adapter.getPreferences
  )?.preferences
}
