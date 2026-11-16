import type { PluginServices, PluginSetup } from '@dia/plugin'
import { actions, addEntry, fillSlot, openSettings, SIDEBAR } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { SettingsPagesSlot } from '@dia-plugin/dia-settings/slots'
import { Effect } from 'effect'
import { ArchiveIcon, FolderIcon, SettingsIcon, SquarePenIcon } from 'lucide-react'
import { ArchivedThreadsSettings } from './archived-threads-settings'
import { ProjectsSettings } from './projects-settings'
import { ThreadsSidebar } from './threads-sidebar'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* fillSlot(ctx, SIDEBAR, ThreadsSidebar)
    yield* addEntry(ctx, CommandsSlot, {
      id: 'new-thread',
      order: 5,
      group: 'Threads',
      label: 'New thread',
      icon: SquarePenIcon,
      keywords: ['draft', 'start', 'compose'],
      run: () => actions.newThread()
    })
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'projects',
      order: 15,
      label: 'Projects',
      icon: FolderIcon,
      component: ProjectsSettings
    })
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'archived-threads',
      order: 16,
      label: 'Archived threads',
      icon: ArchiveIcon,
      component: ArchivedThreadsSettings
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'settings-projects',
      order: 115,
      group: 'Settings pages',
      label: 'Settings › Projects',
      icon: SettingsIcon,
      keywords: ['projects', 'directory', 'remove', 'add'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'dia-threads', id: 'projects' })
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'settings-archived-threads',
      order: 116,
      group: 'Settings pages',
      label: 'Settings › Archived threads',
      icon: SettingsIcon,
      keywords: ['archived', 'threads', 'unarchive', 'restore'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'dia-threads', id: 'archived-threads' })
    })
  })

export default setup
