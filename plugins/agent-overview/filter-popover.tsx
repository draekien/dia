import {
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  StatusIndicator,
  statusLabel
} from '@dia/renderer-plugin'
import {
  StatusFailed,
  StatusFinished,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking
} from '@shared/domain/agent-summary'
import { ListFilterIcon } from 'lucide-react'
import { NO_FILTERS, type OverviewFilters, STATUS_TAGS, type StatusTag } from './overview'

const SAMPLE_STATUS = {
  StatusNeedsInput: StatusNeedsInput.make({ reason: '' }),
  StatusFailed: StatusFailed.make({ reason: '' }),
  StatusWorking: StatusWorking.make({}),
  StatusFinished: StatusFinished.make({}),
  StatusIdle: StatusIdle.make({})
} as const

interface FilterPopoverProps {
  readonly filters: OverviewFilters
  readonly counts: Readonly<Record<StatusTag, number>>
  readonly onChange: (filters: OverviewFilters) => void
}

function CheckRow({
  id,
  checked,
  onChange,
  children
}: {
  readonly id: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly children: React.ReactNode
}) {
  return (
    <label htmlFor={id} className="flex h-7 cursor-default items-center gap-2 text-sm text-ink">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      {children}
    </label>
  )
}

/**
 * The filter icon button and its popover: one checkbox per status with its agent count, "Show
 * archived agents", "Hide projects with no matches" and "Clear filters". A dot on the button
 * marks an active status filter.
 */
export function FilterPopover({ filters, counts, onChange }: FilterPopoverProps) {
  const active = filters.statuses.length > 0 || filters.showArchived
  const toggleStatus = (tag: StatusTag, checked: boolean) =>
    onChange({
      ...filters,
      statuses: checked
        ? STATUS_TAGS.filter(
            (candidate) => candidate === tag || filters.statuses.includes(candidate)
          )
        : filters.statuses.filter((candidate) => candidate !== tag)
    })
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={active ? 'Filter agents, filters active' : 'Filter agents'}
          className="relative"
        >
          <ListFilterIcon />
          {active && (
            <span
              aria-hidden
              className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-64 flex-col gap-1 p-3">
        <span className="pb-1 text-xs font-medium text-ink-muted">Show status</span>
        {STATUS_TAGS.map((tag) => (
          <CheckRow
            key={tag}
            id={`overview-filter-${tag}`}
            checked={filters.statuses.includes(tag)}
            onChange={(checked) => toggleStatus(tag, checked)}
          >
            <StatusIndicator status={SAMPLE_STATUS[tag]} />
            <span className="flex-1">{statusLabel(SAMPLE_STATUS[tag])}</span>
            <span className="text-xs tabular-nums text-ink-muted">{counts[tag]}</span>
          </CheckRow>
        ))}
        <Separator className="my-1.5" />
        <CheckRow
          id="overview-filter-archived"
          checked={filters.showArchived}
          onChange={(showArchived) => onChange({ ...filters, showArchived })}
        >
          Show archived agents
        </CheckRow>
        <CheckRow
          id="overview-filter-hide-unmatched"
          checked={filters.hideUnmatchedProjects}
          onChange={(hideUnmatchedProjects) => onChange({ ...filters, hideUnmatchedProjects })}
        >
          Hide projects with no matches
        </CheckRow>
        <Separator className="my-1.5" />
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => onChange({ ...NO_FILTERS, query: filters.query })}
        >
          Clear filters
        </Button>
      </PopoverContent>
    </Popover>
  )
}
