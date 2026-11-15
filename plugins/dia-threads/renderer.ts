import type { PluginServices, PluginSetup } from '@dia/plugin'
import { actions, addEntry, fillSlot, SIDEBAR } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { Effect } from 'effect'
import { SquarePenIcon } from 'lucide-react'
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
  })

export default setup
