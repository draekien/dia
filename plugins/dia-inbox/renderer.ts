import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { PagesSlot } from '@dia-plugin/dia-layout/slots'
import { Effect } from 'effect'
import { InboxIcon } from 'lucide-react'
import { createElement } from 'react'
import { InboxPage, makeInboxAtom } from './inbox-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const inboxAtom = makeInboxAtom(ctx)
    yield* addEntry(ctx, PagesSlot, {
      id: 'inbox',
      order: 5,
      label: 'Inbox',
      icon: InboxIcon,
      component: () => createElement(InboxPage, { inboxAtom })
    })
    yield* Effect.logInfo('Inbox renderer plugin opened', ctx.name)
  })

export default setup
