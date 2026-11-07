import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, openSettings } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/command-palette/slots'
import { SettingsPagesSlot } from '@dia-plugin/settings/slots'
import { Effect } from 'effect'
import { FolderGitIcon, SettingsIcon } from 'lucide-react'
import { MetaRepoSettings } from './meta-repo-settings'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'meta',
      order: 40,
      label: 'Meta repo',
      icon: FolderGitIcon,
      component: MetaRepoSettings
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'meta',
      order: 140,
      group: 'Settings pages',
      label: 'Settings › Meta repo',
      icon: SettingsIcon,
      keywords: ['meta', 'remote', 'push', 'git', 'secret'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'meta', id: 'meta' })
    })
  })

export default setup
