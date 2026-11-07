import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, declareList, openSettings } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/command-palette/slots'
import { DialogsSlot } from '@dia-plugin/layout/slots'
import { SettingsPagesSlot } from '@dia-plugin/settings/slots'
import { Effect } from 'effect'
import { PuzzleIcon, SettingsIcon, SlidersHorizontalIcon } from 'lucide-react'
import { GeneralSettings } from './general-settings'
import { PluginSettings } from './plugin-settings'
import { SettingsDialog } from './settings-dialog'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* declareList(ctx, SettingsPagesSlot)
    yield* addEntry(ctx, DialogsSlot, { id: 'settings', order: 10, component: SettingsDialog })
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'general',
      order: 10,
      label: 'General',
      icon: SlidersHorizontalIcon,
      component: GeneralSettings
    })
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'plugins',
      order: 30,
      label: 'Plugins',
      icon: PuzzleIcon,
      component: PluginSettings
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'settings',
      order: 10,
      group: 'Settings',
      label: 'Settings',
      icon: SettingsIcon,
      run: () => openSettings()
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'general',
      order: 110,
      group: 'Settings pages',
      label: 'Settings › General',
      icon: SettingsIcon,
      keywords: ['theme', 'dark', 'light', 'send mode', 'queue', 'steer', 'transcript width'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'settings', id: 'general' })
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'plugins',
      order: 130,
      group: 'Settings pages',
      label: 'Settings › Plugins',
      icon: SettingsIcon,
      keywords: ['plugin', 'extensions'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'settings', id: 'plugins' })
    })
  })

export default setup
