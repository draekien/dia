import type { PaneId, PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { PanelsSlot, RailCardsSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { createElement } from 'react'
import { makePullRequestAtoms } from './atoms'
import { PullRequestPanel } from './pull-request-panel'
import { PullRequestsCard } from './pull-requests-card'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const atoms = makePullRequestAtoms(ctx)
    const panel = { plugin: ctx.name, id: 'pull-request' }
    yield* addEntry(ctx, RailCardsSlot, {
      id: 'pull-requests',
      order: 60,
      title: 'Pull requests',
      component: ({ paneId }: { readonly paneId: PaneId }) =>
        createElement(PullRequestsCard, { runId: paneId, atoms, panel })
    })
    yield* addEntry(ctx, PanelsSlot, {
      id: panel.id,
      order: 50,
      title: 'Pull request',
      component: ({ paneId }: { readonly paneId: PaneId }) =>
        createElement(PullRequestPanel, { runId: paneId, atoms })
    })
    yield* Effect.logInfo('Pull requests card and panel added', { plugin: ctx.name })
  })

export default setup
