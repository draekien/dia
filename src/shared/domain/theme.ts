import { Schema } from 'effect'

/**
 * The user's persisted colour-theme choice. `light` and `dark` pin the theme
 * explicitly; `system` defers to the OS colour-scheme setting, tracking it live.
 * Persisted by the main-process settings store and applied by the renderer's
 * theme provider. A closed literal union, so no other theme value is
 * representable anywhere it flows (settings file, IPC, renderer state).
 */
export const ThemePreference = Schema.Literal('light', 'dark', 'system')
export type ThemePreference = typeof ThemePreference.Type

/**
 * The default theme when none has been persisted yet: defer to the OS.
 * Applied wherever an absent stored preference must resolve to a concrete value.
 */
export const DEFAULT_THEME: ThemePreference = 'system'
