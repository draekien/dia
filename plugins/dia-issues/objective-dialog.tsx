// @effect-diagnostics asyncFunction:off -- React callbacks await IssuesCall's Promise; components hold no Effect runtime.
import type { ProjectId } from '@dia/plugin'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  ToggleGroup,
  ToggleGroupItem
} from '@dia/renderer-plugin'
import { Result } from 'effect'
import { Loader2Icon } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { CreateObjective } from './calls'
import { type Objective, ObjectiveId, ObjectivePriority, PRIORITY_LABELS } from './domain'
import { failureText, type IssuesCall, newId, readWorkTitle } from './issue-actions'

/** A registered project the objective form offers: its id and the name to show. */
export interface ProjectChoice {
  readonly id: ProjectId
  readonly name: string
}

interface Errors {
  readonly project?: string
  readonly title?: string
  readonly create?: string
}

/**
 * The New objective dialog: a project from `projects`, a title, a description and a priority
 * (default Normal). `Create` sends the `CreateObjective` call for an unassigned objective with no
 * issues; on success `onCreated` gets the new objective. With no projects it asks the user to add
 * one and offers no `Create`.
 */
export function ObjectiveDialog({
  projects,
  call,
  onCreated,
  onClose
}: {
  readonly projects: ReadonlyArray<ProjectChoice>
  readonly call: IssuesCall
  readonly onCreated: (objective: Objective) => void
  readonly onClose: () => void
}) {
  const [chosenProject, setProjectId] = useState<ProjectId | null>(null)
  const projectId = chosenProject ?? projects[0]?.id ?? null
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<ObjectivePriority>('normal')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const project = projects.find((choice) => choice.id === projectId)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (projectId === null) return setErrors({ project: 'Choose a project' })
    const readTitle = readWorkTitle(title)
    if (Result.isFailure(readTitle)) return setErrors({ title: readTitle.failure })
    setBusy(true)
    const id = ObjectiveId.make(newId())
    const result = await call(
      CreateObjective,
      {
        objective: {
          id,
          projectId,
          title: readTitle.success,
          description: description.trim(),
          priority,
          assignee: null
        }
      },
      id
    ).finally(() => setBusy(false))
    if (Result.isSuccess(result)) return onCreated(result.success)
    const failure = result.failure
    switch (failure._tag) {
      case 'ProjectNotFound':
        return setErrors({ project: 'This project was removed' })
      default:
        return setErrors({ create: failureText(failure) })
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New objective</DialogTitle>
          <DialogDescription>Add its issues on the objective once it is created.</DialogDescription>
        </DialogHeader>
        {projects.length === 0 ? (
          <>
            <p className="text-sm text-ink-muted">
              Add a project first. An objective belongs to a registered project.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
            <div className="flex flex-col gap-1.5">
              <Label>Project</Label>
              <Select
                value={projectId}
                onValueChange={(value) => {
                  setProjectId(value as ProjectId | null)
                  setErrors({})
                }}
              >
                <SelectTrigger
                  aria-label="Project"
                  aria-invalid={errors.project !== undefined}
                  className="w-full"
                >
                  <SelectValue>{project?.name ?? 'Choose a project'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {projects.map((choice) => (
                      <SelectItem key={choice.id} value={choice.id}>
                        {choice.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {errors.project === undefined ? null : (
                <p className="text-xs text-error">{errors.project}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={titleId}>Title</Label>
              <Input
                id={titleId}
                value={title}
                autoComplete="off"
                aria-invalid={errors.title !== undefined}
                onChange={(event) => {
                  setTitle(event.target.value)
                  setErrors({})
                }}
              />
              {errors.title === undefined ? null : (
                <p className="text-xs text-error">{errors.title}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={descriptionId}>Description</Label>
              <Textarea
                id={descriptionId}
                value={description}
                placeholder="Optional"
                rows={3}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Priority</Label>
              <ToggleGroup
                value={[priority]}
                onValueChange={([value]) => {
                  if (value !== undefined) setPriority(value as ObjectivePriority)
                }}
                variant="outline"
                size="sm"
                aria-label="Priority"
              >
                {ObjectivePriority.literals.map((value) => (
                  <ToggleGroupItem key={value} value={value}>
                    {PRIORITY_LABELS[value]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <DialogFooter className="items-center">
              {errors.create === undefined ? null : (
                <p role="alert" className="mr-auto text-xs text-error">
                  {errors.create}
                </p>
              )}
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
                ) : null}
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
