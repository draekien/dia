import type { PaneId, PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { RailCardsSlot, TurnFootersSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { createElement } from 'react'
import { TurnUsageLine } from './turn-usage-line'
import { makeUsageAtoms, UsageCard } from './usage-card'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const usageAtoms = makeUsageAtoms(ctx)
    yield* addEntry(ctx, RailCardsSlot, {
      id: 'usage',
      order: 50,
      title: 'Usage',
      component: ({ paneId }: { readonly paneId: PaneId }) =>
        createElement(UsageCard, { runId: paneId, usageAtoms })
    })
    yield* addEntry(ctx, TurnFootersSlot, {
      id: 'turn-usage',
      order: 10,
      component: ({ paneId, messageIds }) =>
        createElement(TurnUsageLine, { runId: paneId, messageIds, usageAtoms })
    })
    yield* Effect.logInfo('Usage card and turn usage line added', { plugin: ctx.name })
  })

export default setup
