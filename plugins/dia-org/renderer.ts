import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, callHost, followHost, openSettings } from '@dia/renderer-plugin'
import { ThreadTargetsSlot } from '@dia-plugin/dia-chat/slots'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { PagesSlot, SidebarSectionsSlot } from '@dia-plugin/dia-layout/slots'
import { SettingsPagesSlot } from '@dia-plugin/dia-settings/slots'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { SettingsIcon, SparklesIcon, UsersIcon } from 'lucide-react'
import { createElement } from 'react'
import { AgentsSection } from './agents-section'
import { AssistantPage, assistantRunIdAtom } from './assistant-page'
import { AskAssistant, ReadOrg, WatchAgentRuns, WatchOrgLive } from './calls'
import { showAssistantRun } from './onboarding'
import { OrgPage } from './org-page'
import { OrgSettingsPage } from './org-settings-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const orgAtom = Atom.make(callHost(ctx, ReadOrg, {}))
    const liveAtom = Atom.make(followHost(ctx, WatchOrgLive, {}))
    const runsAtom = Atom.make(followHost(ctx, WatchAgentRuns, {}))
    yield* addEntry(ctx, PagesSlot, {
      id: 'org',
      order: 10,
      label: 'Org',
      icon: UsersIcon,
      component: ({ target }) => createElement(OrgPage, { ctx, orgAtom, liveAtom, key: target })
    })
    yield* addEntry(ctx, PagesSlot, {
      id: 'assistant',
      order: 10.5,
      label: 'Assistant',
      icon: SparklesIcon,
      tab: assistantRunIdAtom(liveAtom),
      component: () => createElement(AssistantPage, { ctx, liveAtom })
    })
    yield* addEntry(ctx, ThreadTargetsSlot, {
      id: 'assistant',
      order: 10,
      label: 'Assistant',
      icon: SparklesIcon,
      send: (text) =>
        callHost(ctx, AskAssistant, { text }).pipe(
          Effect.flatMap(showAssistantRun),
          Effect.mapError((failure) =>
            failure._tag === 'AssistantDisabled'
              ? 'The Executive assistant job title is disabled. Turn it on in Settings › Org.'
              : `The Assistant could not take the message: ${failure.message}`
          )
        )
    })
    yield* addEntry(ctx, SidebarSectionsSlot, {
      id: 'agents',
      order: 10,
      component: ({ iconMode }) => createElement(AgentsSection, { runsAtom, iconMode })
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
      run: () => openSettings({ plugin: 'dia-org', id: 'org' })
    })
    yield* Effect.logInfo('Org renderer plugin opened', ctx.name)
  })

export default setup
