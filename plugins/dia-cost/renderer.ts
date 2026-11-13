import type { PaneId, PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { RailCardsSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { createElement } from 'react'
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
    yield* Effect.logInfo('Usage card added', { plugin: ctx.name })
  })

export default setup
