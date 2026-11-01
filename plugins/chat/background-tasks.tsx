import { Button, Popover, PopoverContent, PopoverTrigger } from '@dia/renderer-plugin'
import type { BackgroundTask } from '@shared/domain/background-task'
import { composerSettingTrigger } from './composer-settings'

const taskCount = (count: number): string => (count === 1 ? '1 task' : `${count} tasks`)

/**
 * The composer header's background work control: `N in background` as a muted caption-size
 * trigger, rendered only while `tasks` is not empty. It opens a popover listing each task's
 * description, in the order given. Pass the pane's `backgroundTasks`.
 */
export function BackgroundTasks({
  tasks
}: {
  tasks: ReadonlyArray<BackgroundTask>
}): React.JSX.Element | null {
  if (tasks.length === 0) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={composerSettingTrigger()}
          aria-label={`${taskCount(tasks.length)} running in the background`}
        >
          {tasks.length} in background
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-2 text-sm">
        <p className="font-medium">Running in the background</p>
        <ul className="flex flex-col gap-1.5 text-muted-foreground text-xs">
          {tasks.map((task) => (
            <li key={task.taskId} className="break-words">
              {task.description}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
