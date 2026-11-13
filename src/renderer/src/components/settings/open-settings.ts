import { Effect } from 'effect'

/** The window event the Settings dialog listens for; its `detail` is the requested {@link SettingsLocation}. */
export const OPEN_SETTINGS_EVENT = 'dia:open-settings'

/**
 * A Settings page: `plugin` and `id` are the key of the page's `SettingsPagesSlot` entry (the
 * adding plugin's name and the entry's `id`). `section` names a part of that page, which the page
 * interprets; the Adapters page reads it as an adapter plugin's name.
 */
export type SettingsLocation = {
  readonly plugin: string
  readonly id: string
  readonly section?: string
}

/** The Claude Code panel of the Adapters page. */
export const CLAUDE_CODE_SETTINGS: SettingsLocation = {
  plugin: 'dia-adapters',
  id: 'adapters',
  section: 'dia-claude-code'
}

/**
 * Opens the Settings dialog on `location`, or on the page last viewed when omitted. Call it from
 * anywhere in the renderer; the Settings dialog responds while the `settings` plugin is loaded.
 */
export function openSettings(location?: SettingsLocation): void {
  Effect.runSync(Effect.logDebug('Opening Settings', { location }))
  window.dispatchEvent(
    new CustomEvent<SettingsLocation | undefined>(OPEN_SETTINGS_EVENT, { detail: location })
  )
}
