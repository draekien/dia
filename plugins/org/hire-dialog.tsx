// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
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
  SelectValue
} from '@dia/renderer-plugin'
import { Result } from 'effect'
import { Loader2Icon } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { Hire, type OrgSnapshot } from './calls'
import type { HiredAgent, HireId, JobTitleId } from './domain'
import { commonFailureText, type OrgCall, readAgentName } from './org-actions'
import { ReportsToSelect } from './org-fields'

interface Errors {
  readonly name?: string
  readonly reportsTo?: string
  readonly hire?: string
}

/**
 * The Hire dialog: an optional name, a job title (fixed to `jobTitleId` when not null, otherwise
 * chosen from the enabled job titles) and who the agent reports to (default the user). `Hire`
 * sends the `Hire` call; on success `onHired` gets the new agent once `snapshot` has been re-read.
 * Each failure shows beside the field it concerns.
 */
export function HireDialog({
  snapshot,
  jobTitleId,
  call,
  onHired,
  onClose
}: {
  readonly snapshot: OrgSnapshot
  readonly jobTitleId: JobTitleId | null
  readonly call: OrgCall
  readonly onHired: (agent: HiredAgent) => void
  readonly onClose: () => void
}) {
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<JobTitleId | null>(jobTitleId)
  const [reportsTo, setReportsTo] = useState<HireId | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const nameId = useId()
  const enabled = snapshot.jobTitles.filter((jobTitle) => jobTitle.enabled)
  const chosenTitle = snapshot.jobTitles.find((jobTitle) => jobTitle.id === chosen)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (chosen === null) return
    const readName = readAgentName(name)
    if (Result.isFailure(readName)) return setErrors({ name: readName.failure })
    setBusy(true)
    const result = await call(
      Hire,
      { jobTitleId: chosen, name: readName.success, reportsTo },
      chosen
    ).finally(() => setBusy(false))
    if (Result.isSuccess(result)) return onHired(result.success)
    const failure = result.failure
    switch (failure._tag) {
      case 'HireNameTaken':
        return setErrors({ name: `An agent named "${failure.agentName}" already exists` })
      case 'HireNotFound':
        return setErrors({ reportsTo: 'The selected manager was dismissed' })
      case 'JobTitleDisabled':
        return setErrors({ hire: 'This job title is disabled' })
      default:
        return setErrors({ hire: commonFailureText(failure) })
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
          <DialogTitle>Hire an agent</DialogTitle>
          <DialogDescription>
            The agent runs with its job title's job description, skills, permissions and MCP
            servers.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              placeholder="Optional"
              autoComplete="off"
              aria-invalid={errors.name !== undefined}
              onChange={(event) => {
                setName(event.target.value)
                setErrors({})
              }}
            />
            {errors.name === undefined ? null : <p className="text-xs text-error">{errors.name}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Job title</Label>
            {jobTitleId === null ? (
              <Select
                value={chosen}
                onValueChange={(value) => {
                  setChosen(value as JobTitleId | null)
                  setErrors({})
                }}
              >
                <SelectTrigger aria-label="Job title" className="w-full">
                  <SelectValue>{chosenTitle?.name ?? 'Choose a job title'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {enabled.map((jobTitle) => (
                      <SelectItem key={jobTitle.id} value={jobTitle.id}>
                        {jobTitle.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-ink">{chosenTitle?.name}</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Reports to</Label>
            <ReportsToSelect
              value={reportsTo}
              choices={snapshot.hiredAgents}
              hiredAgents={snapshot.hiredAgents}
              jobTitles={snapshot.jobTitles}
              onChange={(next) => {
                setReportsTo(next)
                setErrors({})
              }}
            />
            {errors.reportsTo === undefined ? null : (
              <p className="text-xs text-error">{errors.reportsTo}</p>
            )}
          </div>
          <DialogFooter className="items-center">
            {errors.hire === undefined ? null : (
              <p role="alert" className="mr-auto text-xs text-error">
                {errors.hire}
              </p>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || chosen === null}>
              {busy ? (
                <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
              ) : null}
              Hire
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
