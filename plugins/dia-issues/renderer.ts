import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, followHost } from '@dia/renderer-plugin'
import { PagesSlot } from '@dia-plugin/dia-layout/slots'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { ListTodoIcon } from 'lucide-react'
import { createElement } from 'react'
import { WatchIssues } from './calls'
import { IssuesPage } from './issues-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const issuesAtom = Atom.make(followHost(ctx, WatchIssues, {}))
    yield* addEntry(ctx, PagesSlot, {
      id: 'issues',
      order: 11,
      label: 'Issues',
      icon: ListTodoIcon,
      component: ({ target }) => createElement(IssuesPage, { ctx, issuesAtom, target, key: target })
    })
    yield* Effect.logInfo('Issues renderer plugin opened', ctx.name)
  })

export default setup
