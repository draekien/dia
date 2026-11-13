import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, declareList, openSettings } from '@dia/renderer-plugin'
import { AdapterPanelsSlot } from '@dia-plugin/dia-adapters/slots'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { SettingsPagesSlot } from '@dia-plugin/dia-settings/slots'
import { Effect } from 'effect'
import { BlocksIcon, SettingsIcon } from 'lucide-react'
import { AdapterSettings } from './adapter-settings'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* declareList(ctx, AdapterPanelsSlot)
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'adapters',
      order: 20,
      label: 'Adapters',
      icon: BlocksIcon,
      component: AdapterSettings
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'adapters',
      order: 120,
      group: 'Settings pages',
      label: 'Settings › Adapters',
      icon: SettingsIcon,
      keywords: ['adapter'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'dia-adapters', id: 'adapters' })
    })
  })

export default setup
