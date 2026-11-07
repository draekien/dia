import type { BackgroundTask } from '@shared/domain/background-task'
import type { PaneId } from '@shared/domain/pane'
import { usePaneChat } from './use-pane-chat'

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

/** The session rail's Background tasks card body for `paneId`. Add it to `RailCardsSlot` with `addEntry`. */
export function BackgroundTasksCard({ paneId }: { readonly paneId: PaneId }): React.JSX.Element {
  return <BackgroundTaskList tasks={usePaneChat(paneId).backgroundTasks} />
}
