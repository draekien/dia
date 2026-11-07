import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, declareList } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/command-palette/slots'
import { DialogsSlot } from '@dia-plugin/layout/slots'
import { Effect } from 'effect'
import { CodeIcon, InfoIcon } from 'lucide-react'
import { AboutHost, openAbout } from './about-host'
import { CommandPalette } from './command-palette'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* declareList(ctx, CommandsSlot)
    yield* addEntry(ctx, DialogsSlot, { id: 'palette', order: 20, component: CommandPalette })
    yield* addEntry(ctx, DialogsSlot, { id: 'about', order: 30, component: AboutHost })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'about',
      order: 20,
      group: 'Help',
      label: 'About dia',
      icon: InfoIcon,
      run: openAbout
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'dev-tools',
      order: 30,
      group: 'Developer',
      label: 'Toggle Developer Tools',
      icon: CodeIcon,
      run: () => window.dia.toggleDevTools()
    })
  })

export default setup
