import {
  actions,
  Button,
  cn,
  Separator,
  StatusIndicator,
  statusLabel,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@dia/renderer-plugin'
import type { PaneId } from '@shared/domain/pane'
import { PanelLeftOpenIcon } from 'lucide-react'
import { Fragment } from 'react'
import { secondLine } from './agent-row'
import type { OverviewGroup } from './overview'

interface RailProps {
  readonly groups: ReadonlyArray<OverviewGroup>
  readonly visibleTab: PaneId | null
  readonly onExpand: () => void
}

/**
 * The collapsed overview: one status dot per agent in project order, a hairline between
 * projects, and a tooltip naming the project, the agent, its status and its activity. Clicking a
 * dot shows that agent's tab.
 */
export function Rail({ groups, visibleTab, onExpand }: RailProps) {
  const populated = groups.filter((group) => group.rows.length > 0)
  return (
    <aside aria-label="Agents" className="flex w-11 shrink-0 flex-col items-center py-2">
      <nav
        aria-label="Agents by project"
        className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto"
      >
        {populated.map((group, index) => (
          <Fragment key={group.project.projectId}>
            {index > 0 && <Separator className="my-1.5 w-4" />}
            {group.rows.map((row) => {
              const label = `${group.project.displayName} / ${row.name}`
              const status = statusLabel(row.summary.status)
              return (
                <Tooltip key={row.paneId}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${label}, ${status}`}
                      aria-current={row.paneId === visibleTab ? 'page' : undefined}
                      onClick={() => actions.selectTab(row.paneId)}
                      className={cn(
                        'flex size-7 items-center justify-center rounded-md outline-none transition-colors duration-150 ease-out hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                        row.paneId === visibleTab && 'bg-primary/10'
                      )}
                    >
                      <StatusIndicator status={row.summary.status} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {label} · {status} · {secondLine(row.summary).text}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </Fragment>
        ))}
      </nav>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Expand the agent overview"
            onClick={onExpand}
          >
            <PanelLeftOpenIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Expand · Ctrl B</TooltipContent>
      </Tooltip>
    </aside>
  )
}
