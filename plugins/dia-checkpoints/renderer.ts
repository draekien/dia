import type { PaneId, PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { PanelsSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { createElement } from 'react'
import { ChangesPanel, makeChangesAtoms } from './changes-panel'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const changesAtoms = makeChangesAtoms(ctx)
    yield* addEntry(ctx, PanelsSlot, {
      id: 'changes',
      order: 40,
      title: 'Changes',
      component: ({ paneId }: { readonly paneId: PaneId }) =>
        createElement(ChangesPanel, { runId: paneId, changesAtoms })
    })
    yield* Effect.logInfo('Changes panel added', { plugin: ctx.name })
  })

export default setup
