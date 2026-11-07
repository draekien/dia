import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addPage } from '@dia/renderer-plugin'
import { Effect } from 'effect'
import { HandIcon } from 'lucide-react'
import { createElement } from 'react'
import { GreetingPage } from './greeting-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.logInfo('Example renderer plugin closed', ctx.name))
    yield* addPage(ctx, {
      id: 'greeting',
      label: 'Example',
      icon: HandIcon,
      order: 100,
      component: () => createElement(GreetingPage, { ctx })
    })
    yield* Effect.logInfo('Example renderer plugin opened', ctx.name)
  })

export default setup
