import { cn, emptyPaneChatState, type PaneMessage, paneChatAtom } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import { Option, Schema } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { CheckIcon, CircleDotIcon, CircleIcon } from 'lucide-react'
import { useMemo } from 'react'

/** One item of the agent's `TodoWrite` task list. */
export const TodoItem = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(['pending', 'in_progress', 'completed'])
})
export type TodoItem = typeof TodoItem.Type

const decodeTodo = Schema.decodeUnknownOption(TodoItem)

/**
 * The task list of the last `TodoWrite` call in `messages`, in the agent's order, keeping only the
 * items that have a `content` string and a known `status`. Empty when the agent never wrote one.
 */
export const latestTodos = (messages: ReadonlyArray<PaneMessage>): ReadonlyArray<TodoItem> => {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== 'tool-call' || part.name !== 'TodoWrite') continue
      const todos = part.input?.todos
      if (!Array.isArray(todos)) return []
      return todos.flatMap((todo: unknown) => Option.toArray(decodeTodo(todo)))
    }
  }
  return []
}

const statusIcons = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CheckIcon
} as const

const statusLabels = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed'
} as const

/** The agent's task list `todos`, each with its status, or `No task list` when it is empty. */
export function TaskList({ todos }: { todos: ReadonlyArray<TodoItem> }): React.JSX.Element {
  if (todos.length === 0) return <p className="text-muted-foreground">No task list</p>
  return (
    <ul className="flex flex-col gap-1.5">
      {todos.map((todo, index) => {
        const Icon = statusIcons[todo.status]
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: TodoWrite items carry no id, and two items may share their text
            key={index}
            className={cn(
              'flex items-start gap-2',
              todo.status === 'in_progress' ? 'text-foreground' : 'text-muted-foreground',
              todo.status === 'completed' && 'line-through'
            )}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">
              <span className="sr-only">{statusLabels[todo.status]}: </span>
              {todo.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** The session rail's Task list card body for `paneId`. Add it with `addRailCard`. */
export function TaskListCard({ paneId }: { readonly paneId: PaneId }): React.JSX.Element {
  const chat = AsyncResult.getOrElse(useAtomValue(paneChatAtom(paneId)), () => emptyPaneChatState)
  const todos = useMemo(() => latestTodos(chat.messages), [chat.messages])
  return <TaskList todos={todos} />
}
