import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addRailCard, fillSlot, MAIN_TAB } from '@dia/renderer-plugin'
import { Effect } from 'effect'
import { BackgroundTasksCard } from './background-tasks'
import { Chat } from './chat'
import { CONTEXT_CARD_ID, ContextCard } from './context-card'
import { TaskListCard } from './task-list-card'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* fillSlot(ctx, MAIN_TAB, Chat)
    yield* addRailCard(ctx, { id: CONTEXT_CARD_ID, title: 'Context', component: ContextCard })
    yield* addRailCard(ctx, {
      id: 'background-tasks',
      title: 'Background tasks',
      component: BackgroundTasksCard
    })
    yield* addRailCard(ctx, { id: 'task-list', title: 'Task list', component: TaskListCard })
  })

export default setup
