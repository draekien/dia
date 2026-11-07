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

const YOU = 'you'

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
  const manager = hiredAgents.find((agent) => agent.id === value)
  return (
    <Select
      value={value ?? YOU}
      onValueChange={(next) => onChange(next === YOU || next === null ? null : (next as HireId))}
    >
      <SelectTrigger aria-label="Reports to" className="w-full">
        <SelectValue>{manager === undefined ? 'You' : agentName(manager, jobTitles)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={YOU}>You</SelectItem>
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
