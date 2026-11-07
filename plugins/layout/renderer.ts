import type { PluginServices, PluginSetup } from '@dia/plugin'
import { actions, declareList, fillSlot, ROOT } from '@dia/renderer-plugin'
import { DialogsSlot, PagesSlot } from '@dia-plugin/layout/slots'
import { Effect } from 'effect'
import { Layout } from './layout'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* declareList(ctx, PagesSlot, {
      onRemove: (page) => Effect.sync(() => actions.closePage(page.key))
    })
    yield* declareList(ctx, DialogsSlot)
    yield* fillSlot(ctx, ROOT, Layout)
  })

export default setup
