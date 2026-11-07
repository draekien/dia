import { ListSlot } from '@dia/plugin'
import type { ComponentType } from 'react'

/** A part of a Settings page the page reported showing: `id` is its key, `label` its breadcrumb text. */
export interface SettingsSection {
  readonly id: string
  readonly label: string
}

/**
 * What the Settings dialog passes a page. `requestedSection` is the section the page should show:
 * the `section` of the location the dialog was opened with, replaced by each section the page
 * reports, and `undefined` when the dialog opens on this page with no section. `lastSection` is
 * the `id` the page last reported. Call `onSectionShown` whenever the section shown changes; the
 * dialog shows its `label` as the last breadcrumb.
 */
export interface SettingsPageProps {
  readonly requestedSection: string | undefined
  readonly lastSection: string | undefined
  readonly onSectionShown: (section: SettingsSection | undefined) => void
}

/** A page of the Settings dialog. `label` is its nav entry and breadcrumb; `component` draws the page body. */
export interface SettingsPage {
  readonly id: string
  readonly order: number
  readonly label: string
  readonly icon: ComponentType<{ readonly className?: string }>
  readonly component: ComponentType<SettingsPageProps>
}

/**
 * The Settings dialog's pages, declared by the settings plugin. Add a page with
 * `addEntry(ctx, SettingsPagesSlot, page)`, and open it with `openSettings({ plugin, id })`.
 */
export const SettingsPagesSlot = ListSlot.make<SettingsPage>('settings.pages')
