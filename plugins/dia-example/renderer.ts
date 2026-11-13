import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, callHost } from '@dia/renderer-plugin'
import { PanelsSlot } from '@dia-plugin/dia-chat/slots'
import { ReadGreeting } from '@dia-plugin/dia-example/messages'
import { PagesSlot } from '@dia-plugin/dia-layout/slots'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { HandIcon } from 'lucide-react'
import { createElement } from 'react'
import { ExamplePanel } from './example-panel'
import { GreetingPage } from './greeting-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.logInfo('Example renderer plugin closed', ctx.name))
    const greeting = Atom.make(callHost(ctx, ReadGreeting, {}))
    yield* addEntry(ctx, PagesSlot, {
      id: 'greeting',
      label: 'Example',
      icon: HandIcon,
      order: 100,
      component: () => createElement(GreetingPage, { greeting })
    })
    yield* addEntry(ctx, PanelsSlot, {
      id: 'example',
      order: 100,
      title: 'Example',
      component: ExamplePanel
    })
    yield* Effect.logInfo('Example renderer plugin opened', ctx.name)
  })

export default setup
