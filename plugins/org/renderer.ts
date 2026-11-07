import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, callHost, followHost, openSettings } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/command-palette/slots'
import { PagesSlot } from '@dia-plugin/layout/slots'
import { SettingsPagesSlot } from '@dia-plugin/settings/slots'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { SettingsIcon, UsersIcon } from 'lucide-react'
import { createElement } from 'react'
import { ReadOrg, WatchWork } from './calls'
import { OrgPage } from './org-page'
import { OrgSettingsPage } from './org-settings-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const orgAtom = Atom.make(callHost(ctx, ReadOrg, {}))
    const workAtom = Atom.make(followHost(ctx, WatchWork, {}))
    yield* addEntry(ctx, PagesSlot, {
      id: 'org',
      order: 10,
      label: 'Org',
      icon: UsersIcon,
      component: () => createElement(OrgPage, { ctx, orgAtom, workAtom })
    })
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'org',
      order: 50,
      label: 'Org',
      icon: UsersIcon,
      component: () => createElement(OrgSettingsPage, { ctx, orgAtom })
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'org-settings',
      order: 150,
      group: 'Settings pages',
      label: 'Settings › Org',
      icon: SettingsIcon,
      keywords: ['org', 'cap', 'hired agents', 'running at once'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'org', id: 'org' })
    })
    yield* Effect.logInfo('Org renderer plugin opened', ctx.name)
  })

export default setup
