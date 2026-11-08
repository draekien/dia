// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
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
import { CreateObjective, type OrgSnapshot } from './calls'
import {
  type HireId,
  type Objective,
  ObjectiveId,
  ObjectivePriority,
  PRIORITY_LABELS
} from './domain'
import { commonFailureText, newId, type OrgCall, readWorkTitle } from './org-actions'
import { AssigneeSelect } from './org-fields'

/** A registered project the objective form offers: its id and the name to show. */
export interface ProjectChoice {
  readonly id: ProjectId
  readonly name: string
}

interface Errors {
  readonly project?: string
  readonly title?: string
  readonly assignee?: string
  readonly create?: string
}

/**
 * The New objective dialog: a project from `projects`, a title, a description, a priority (default
 * Normal) and an assignee from `snapshot`'s hired agents, or none. `Create` sends the
 * `CreateObjective` call; on success `onCreated` gets the new objective. With no projects it asks
 * the user to add one and offers no `Create`.
 */
export function ObjectiveDialog({
  snapshot,
  projects,
  call,
  onCreated,
  onClose
}: {
  readonly snapshot: OrgSnapshot
  readonly projects: ReadonlyArray<ProjectChoice>
  readonly call: OrgCall
  readonly onCreated: (objective: Objective) => void
  readonly onClose: () => void
}) {
  const [chosenProject, setProjectId] = useState<ProjectId | null>(null)
  const projectId = chosenProject ?? projects[0]?.id ?? null
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<ObjectivePriority>('normal')
  const [assignee, setAssignee] = useState<HireId | null>(null)
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
          assignee
        }
      },
      id
    ).finally(() => setBusy(false))
    if (Result.isSuccess(result)) return onCreated(result.success)
    const failure = result.failure
    switch (failure._tag) {
      case 'ProjectNotFound':
        return setErrors({ project: 'This project was removed' })
      case 'HireNotFound':
        return setErrors({ assignee: 'This agent was dismissed' })
      default:
        return setErrors({ create: commonFailureText(failure) ?? failure._tag })
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
          <DialogDescription>
            Its planning issue goes to the assignee, or waits until you assign it.
          </DialogDescription>
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
            <div className="flex flex-col gap-1.5">
              <Label>Assignee</Label>
              <AssigneeSelect
                label="Assignee"
                none="Unassigned"
                value={assignee}
                hiredAgents={snapshot.hiredAgents}
                jobTitles={snapshot.jobTitles}
                className="w-full"
                onChange={(next) => {
                  setAssignee(next)
                  setErrors({})
                }}
              />
              {errors.assignee === undefined ? null : (
                <p className="text-xs text-error">{errors.assignee}</p>
              )}
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
