import {
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@dia/renderer-plugin'
import { Cause } from 'effect'
import type { HiredAgent, HireId, JobTitle } from './domain'
import { agentName } from './org-actions'

/**
 * A `Reports to` select of `You` and `choices`, showing `value` (null is `You`). `onChange` gets
 * the chosen agent's id, or null for `You`.
 */
export function ReportsToSelect({
  value,
  choices,
  hiredAgents,
  jobTitles,
  onChange
}: {
  readonly value: HireId | null
  readonly choices: ReadonlyArray<HiredAgent>
  readonly hiredAgents: ReadonlyArray<HiredAgent>
  readonly jobTitles: ReadonlyArray<JobTitle>
  readonly onChange: (reportsTo: HireId | null) => void
}) {
  return (
    <AssigneeSelect
      label="Reports to"
      none="You"
      value={value}
      choices={choices}
      hiredAgents={hiredAgents}
      jobTitles={jobTitles}
      className="w-full"
      onChange={onChange}
    />
  )
}

const NONE = 'none'

/**
 * A select named `label` of `none` (the label of no agent) and `choices` (default every agent of
 * `hiredAgents`), showing `value`, looked up in `hiredAgents` (null is `none`). `onChange` gets
 * the chosen agent's id, or null for `none`.
 */
export function AssigneeSelect({
  label,
  none,
  value,
  hiredAgents,
  choices = hiredAgents,
  jobTitles,
  disabled = false,
  className,
  onChange
}: {
  readonly label: string
  readonly none: string
  readonly value: HireId | null
  readonly hiredAgents: ReadonlyArray<HiredAgent>
  readonly choices?: ReadonlyArray<HiredAgent>
  readonly jobTitles: ReadonlyArray<JobTitle>
  readonly disabled?: boolean
  readonly className?: string
  readonly onChange: (hireId: HireId | null) => void
}) {
  const assignee = hiredAgents.find((agent) => agent.id === value)
  return (
    <Select
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NONE || next === null ? null : (next as HireId))}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue>{assignee === undefined ? none : agentName(assignee, jobTitles)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={NONE}>{none}</SelectItem>
          {choices.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agentName(agent, jobTitles)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/** The failed read of an org page: the first error's message in error red, and `Try again`. */
export function LoadFailure({
  cause,
  retry
}: {
  readonly cause: Cause.Cause<unknown>
  readonly retry: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-error">{Cause.prettyErrors(cause)[0]?.message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}
