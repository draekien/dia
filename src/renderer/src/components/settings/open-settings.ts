import { Effect } from 'effect'

/** The window event a mounted `SettingsDialog` listens for; its `detail` is the requested {@link SettingsLocation}. */
export const OPEN_SETTINGS_EVENT = 'dia:open-settings'

/** A page of the Settings dialog; `adapter` names an adapter plugin (`PluginInfo.name`). */
export type SettingsLocation =
  | { readonly page: 'general' }
  | { readonly page: 'adapters'; readonly adapter?: string }
  | { readonly page: 'plugins' }

/**
 * Opens the Settings dialog on `location`, or on the page last viewed when omitted. Call it from
 * anywhere in the renderer; a mounted `SettingsDialog` responds.
 */
export function openSettings(location?: SettingsLocation): void {
  Effect.runSync(Effect.logDebug('Opening Settings', { location }))
  window.dispatchEvent(
    new CustomEvent<SettingsLocation | undefined>(OPEN_SETTINGS_EVENT, { detail: location })
  )
}
