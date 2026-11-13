import type { PaneId, PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { RailCardsSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { createElement } from 'react'
import { ChangesCard, makeChangesAtoms } from './changes-card'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const changesAtoms = makeChangesAtoms(ctx)
    yield* addEntry(ctx, RailCardsSlot, {
      id: 'changes',
      order: 40,
      title: 'Changes',
      component: ({ paneId }: { readonly paneId: PaneId }) =>
        createElement(ChangesCard, { runId: paneId, changesAtoms })
    })
    yield* Effect.logInfo('Changes card added', { plugin: ctx.name })
  })

export default setup
