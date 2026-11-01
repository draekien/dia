import { emptyPaneChatState, paneChatAtom } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import type { BackgroundTask } from '@shared/domain/background-task'
import type { PaneId } from '@shared/domain/pane'
import { AsyncResult } from 'effect/reactivity'

/**
 * The list of the agent's background `tasks` (background shells, subagents): each task's
 * description, in the order given, or `None running` when the list is empty.
 */
export function BackgroundTaskList({
  tasks
}: {
  tasks: ReadonlyArray<BackgroundTask>
}): React.JSX.Element {
  if (tasks.length === 0) return <p className="text-muted-foreground">None running</p>
  return (
    <ul className="flex flex-col gap-1.5">
      {tasks.map((task) => (
        <li key={task.taskId} className="break-words">
          {task.description}
        </li>
      ))}
    </ul>
  )
}

/** The session rail's Background tasks card body for `paneId`. Add it with `addRailCard`. */
export function BackgroundTasksCard({ paneId }: { readonly paneId: PaneId }): React.JSX.Element {
  const chat = AsyncResult.getOrElse(useAtomValue(paneChatAtom(paneId)), () => emptyPaneChatState)
  return <BackgroundTaskList tasks={chat.backgroundTasks} />
}
