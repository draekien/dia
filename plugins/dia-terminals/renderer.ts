import type { PaneId, PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { RailCardsSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { createElement } from 'react'
import { makeTerminalsAtoms, TerminalsCard } from './terminals-card'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const terminalsAtoms = makeTerminalsAtoms(ctx)
    yield* addEntry(ctx, RailCardsSlot, {
      id: 'terminals',
      order: 50,
      title: 'Terminals',
      component: ({ paneId }: { readonly paneId: PaneId }) =>
        createElement(TerminalsCard, { runId: paneId, terminalsAtoms })
    })
    yield* Effect.logInfo('Terminals card added', { plugin: ctx.name })
  })

export default setup
