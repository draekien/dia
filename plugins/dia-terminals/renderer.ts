import type { PaneId, PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { BottomPanelsSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { createElement } from 'react'
import { makeTerminalsAtoms, TerminalsPanel } from './terminals-panel'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const terminalsAtoms = makeTerminalsAtoms(ctx)
    yield* addEntry(ctx, BottomPanelsSlot, {
      id: 'terminals',
      order: 10,
      title: 'Terminals',
      component: ({ paneId }: { readonly paneId: PaneId }) =>
        createElement(TerminalsPanel, { runId: paneId, terminalsAtoms })
    })
    yield* Effect.logInfo('Terminals panel added', { plugin: ctx.name })
  })

export default setup
