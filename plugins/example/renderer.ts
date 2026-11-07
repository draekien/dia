import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addPage, callHost } from '@dia/renderer-plugin'
import { ReadGreeting } from '@dia-plugin/example/messages'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { HandIcon } from 'lucide-react'
import { createElement } from 'react'
import { GreetingPage } from './greeting-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.logInfo('Example renderer plugin closed', ctx.name))
    const greeting = Atom.make(callHost(ctx, ReadGreeting, {}))
    yield* addPage(ctx, {
      id: 'greeting',
      label: 'Example',
      icon: HandIcon,
      order: 100,
      component: () => createElement(GreetingPage, { greeting })
    })
    yield* Effect.logInfo('Example renderer plugin opened', ctx.name)
  })

export default setup
