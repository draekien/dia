import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@dia/renderer-plugin'
import { type AssigneeGroup, AssigneeRef, ProviderId } from './domain'
import { assigneeLabel } from './issue-actions'

const NONE = 'none'

const itemValue = (assignee: AssigneeRef): string => `${assignee.provider}:${assignee.id}`

const toAssignee = (value: string): AssigneeRef | null => {
  const split = value.indexOf(':')
  return value === NONE || split < 0
    ? null
    : AssigneeRef.make({
        provider: ProviderId.make(value.slice(0, split)),
        id: value.slice(split + 1)
      })
}

/**
 * A select named `label` of `Unassigned` and every assignee `providers` list, grouped under each
 * provider's label, showing `value` (see {@link assigneeLabel}). `onChange` gets the chosen
 * assignee, or null for `Unassigned`.
 */
export function AssigneeSelect({
  label,
  value,
  providers,
  disabled = false,
  className,
  onChange
}: {
  readonly label: string
  readonly value: AssigneeRef | null
  readonly providers: ReadonlyArray<AssigneeGroup>
  readonly disabled?: boolean
  readonly className?: string
  readonly onChange: (assignee: AssigneeRef | null) => void
}) {
  return (
    <Select
      value={value === null ? NONE : itemValue(value)}
      disabled={disabled}
      onValueChange={(next) => onChange(next === null ? null : toAssignee(next))}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue>{assigneeLabel(value, providers, 'Unassigned')}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={NONE}>Unassigned</SelectItem>
        </SelectGroup>
        {providers.map((group) => (
          <SelectGroup key={group.provider}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.assignees.map((assignee) => (
              <SelectItem
                key={assignee.id}
                value={itemValue({ provider: group.provider, id: assignee.id })}
              >
                {assignee.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
