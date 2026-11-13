import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, declareList, fillSlot, MAIN_TAB } from '@dia/renderer-plugin'
import { RailCardsSlot } from '@dia-plugin/dia-chat/slots'
import { Effect } from 'effect'
import { BackgroundTasksCard } from './background-tasks'
import { Chat } from './chat'
import { CONTEXT_CARD_ID, ContextCard } from './context-card'
import { TaskListCard } from './task-list-card'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* declareList(ctx, RailCardsSlot)
    yield* fillSlot(ctx, MAIN_TAB, Chat)
    yield* addEntry(ctx, RailCardsSlot, {
      id: CONTEXT_CARD_ID,
      order: 10,
      title: 'Context',
      component: ContextCard
    })
    yield* addEntry(ctx, RailCardsSlot, {
      id: 'background-tasks',
      order: 20,
      title: 'Background tasks',
      component: BackgroundTasksCard
    })
    yield* addEntry(ctx, RailCardsSlot, {
      id: 'task-list',
      order: 30,
      title: 'Task list',
      component: TaskListCard
    })
  })

export default setup
