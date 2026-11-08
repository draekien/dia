// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import { Button, Input, SettingsRow, toast } from '@dia/renderer-plugin'
import { cva } from 'class-variance-authority'
import { Result } from 'effect'
import { Loader2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { AssignTask, CreateTask, FinishTask, type OrgSnapshot } from './calls'
import {
  type HireId,
  type Objective,
  PRIORITY_LABELS,
  type Task,
  TaskId,
  type TaskState
} from './domain'
import { agentName, commonFailureText, newId, type OrgCall, readWorkTitle } from './org-actions'
import { AssigneeSelect } from './org-fields'

const STATE_LABELS: Record<TaskState, string> = {
  waiting: 'Waiting',
  running: 'Running',
  finished: 'Finished',
  completed: 'Completed'
}

/** The text style of a task's state label, by `state`: a running task reads in full ink, the rest muted. */
export const taskStateVariants = cva('w-16 shrink-0 text-xs', {
  variants: {
    state: {
      waiting: 'text-ink-muted',
      running: 'font-medium text-ink',
      finished: 'text-ink-muted',
      completed: 'text-ink-muted'
    }
  }
})

interface TaskNode {
  readonly task: Task
  readonly children: ReadonlyArray<TaskNode>
}

const taskTree = (tasks: ReadonlyArray<Task>, parent: TaskId | null): ReadonlyArray<TaskNode> =>
  tasks
    .filter((task) => task.parentTaskId === parent)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((task) => ({ task, children: taskTree(tasks, task.id) }))

const taskFailureText = (failure: { readonly _tag: string }): string => {
  switch (failure._tag) {
    case 'TaskNotFound':
      return 'This task was removed'
    case 'TaskNotWaiting':
      return 'This task has already started'
    case 'TaskNotRunning':
      return 'This task is not running'
    case 'ObjectiveNotFound':
      return 'This objective was removed'
    default:
      return commonFailureText(failure) ?? failure._tag
  }
}

const toastTaskFailure = (title: string, failure: { readonly _tag: string }) => {
  toast.add({ title, description: taskFailureText(failure), type: 'error' })
}

function TaskRow({
  task,
  snapshot,
  call
}: {
  readonly task: Task
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  const [finishing, setFinishing] = useState(false)

  const assign = async (hireId: HireId | null) => {
    if (hireId === task.assignee) return
    const result = await call(AssignTask, { taskId: task.id, hireId }, task.id)
    if (Result.isFailure(result)) {
      toastTaskFailure(`Could not assign ${task.title}`, result.failure)
    }
  }

  const finish = async () => {
    setFinishing(true)
    const result = await call(FinishTask, { taskId: task.id }, task.id).finally(() =>
      setFinishing(false)
    )
    if (Result.isFailure(result)) {
      toastTaskFailure(`Could not finish ${task.title}`, result.failure)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-3 py-1">
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{task.title}</span>
      {task.kind === 'retro' ? <span className="text-xs text-ink-muted">Retro</span> : null}
      <span className={taskStateVariants({ state: task.state })}>{STATE_LABELS[task.state]}</span>
      <AssigneeSelect
        label={`Assignee of ${task.title}`}
        none="Unassigned"
        value={task.assignee}
        hiredAgents={snapshot.hiredAgents}
        jobTitles={snapshot.jobTitles}
        disabled={task.state !== 'waiting'}
        className="h-8 w-40"
        onChange={(next) => void assign(next)}
      />
      <span className="flex w-16 shrink-0 justify-end">
        {task.state === 'running' ? (
          <Button size="xs" variant="outline" disabled={finishing} onClick={() => void finish()}>
            {finishing ? (
              <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
            ) : null}
            Finish
          </Button>
        ) : null}
      </span>
    </div>
  )
}

function TaskList({
  nodes,
  nested,
  snapshot,
  call
}: {
  readonly nodes: ReadonlyArray<TaskNode>
  readonly nested: boolean
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  if (nodes.length === 0) return null
  return (
    <ul className={nested ? 'ml-3 flex flex-col border-l pl-3' : 'flex flex-col'}>
      {nodes.map((node) => (
        <li key={node.task.id} aria-label={node.task.title} className="flex flex-col">
          <TaskRow task={node.task} snapshot={snapshot} call={call} />
          <TaskList nodes={node.children} nested snapshot={snapshot} call={call} />
        </li>
      ))}
    </ul>
  )
}

function AddTask({
  objective,
  snapshot,
  call
}: {
  readonly objective: Objective
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState<HireId | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const readTitle = readWorkTitle(title)
    if (Result.isFailure(readTitle)) return setError(readTitle.failure)
    setBusy(true)
    const id = TaskId.make(newId())
    const result = await call(
      CreateTask,
      {
        task: {
          id,
          objectiveId: objective.id,
          parentTaskId: null,
          title: readTitle.success,
          assignee
        }
      },
      id
    ).finally(() => setBusy(false))
    if (Result.isFailure(result)) return setError(taskFailureText(result.failure))
    setTitle('')
    setAssignee(null)
  }

  return (
    <form className="flex flex-col gap-1.5" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={title}
          aria-label="Task title"
          placeholder="New task"
          autoComplete="off"
          aria-invalid={error !== undefined}
          className="h-8 min-w-48 flex-1"
          onChange={(event) => {
            setTitle(event.target.value)
            setError(undefined)
          }}
        />
        <AssigneeSelect
          label="Assignee of the new task"
          none="Unassigned"
          value={assignee}
          hiredAgents={snapshot.hiredAgents}
          jobTitles={snapshot.jobTitles}
          className="h-8 w-40"
          onChange={setAssignee}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          {busy ? (
            <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
          ) : null}
          Add task
        </Button>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </form>
  )
}

/**
 * The detail of `objective`: its title, project (`projectName`), priority, state, assignee and
 * description, then the tree of its tasks among `tasks`, each sub-task under its parent and each
 * retro task under the task it reviews. A waiting task's assignee can change and a running task
 * can be finished; an open objective takes new tasks. Calls go through `call`.
 */
export function ObjectiveScreen({
  objective,
  projectName,
  tasks,
  snapshot,
  call
}: {
  readonly objective: Objective
  readonly projectName: string
  readonly tasks: ReadonlyArray<Task>
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  const own = tasks.filter((task) => task.objectiveId === objective.id)
  const assignee = snapshot.hiredAgents.find((agent) => agent.id === objective.assignee)

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h3 className="text-base font-semibold text-ink">{objective.title}</h3>
      <dl className="flex flex-col gap-4">
        <SettingsRow label="Project">{projectName}</SettingsRow>
        <SettingsRow label="Priority">{PRIORITY_LABELS[objective.priority]}</SettingsRow>
        <SettingsRow label="State">{objective.state === 'open' ? 'Open' : 'Completed'}</SettingsRow>
        <SettingsRow label="Assignee">
          {assignee === undefined ? 'Unassigned' : agentName(assignee, snapshot.jobTitles)}
        </SettingsRow>
        <SettingsRow label="Description">
          {objective.description === '' ? (
            <span className="text-ink-muted">No description</span>
          ) : (
            <p className="max-w-prose whitespace-pre-wrap">{objective.description}</p>
          )}
        </SettingsRow>
      </dl>
      <section className="flex flex-col gap-3 border-t pt-5" aria-labelledby="org-objective-tasks">
        <h4 id="org-objective-tasks" className="text-sm font-medium text-ink">
          Tasks
        </h4>
        {own.length === 0 ? (
          <p className="text-sm text-ink-muted">No tasks yet.</p>
        ) : (
          <TaskList nodes={taskTree(own, null)} nested={false} snapshot={snapshot} call={call} />
        )}
        {objective.state === 'open' ? (
          <AddTask objective={objective} snapshot={snapshot} call={call} />
        ) : null}
      </section>
    </div>
  )
}
