import type { ModelPreferences } from '@shared/domain/model-preferences'
import { useRevisionedSnapshot } from './use-revisioned-snapshot'

/**
 * Keeps the newest model preferences of every adapter and the defaults for new runs through
 * `window.dia.adapter`. Returns `undefined` until the first preferences arrive. Each caller keeps
 * its own copy.
 */
export function useModelPreferences(): ModelPreferences | undefined {
  return useRevisionedSnapshot(
    window.dia.adapter.onPreferencesChanged,
    window.dia.adapter.getPreferences
  )?.preferences
}
