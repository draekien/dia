import {
  actions,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
  StatusIndicator,
  statusLabel
} from '@dia/renderer-plugin'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PaneId } from '@shared/domain/pane'
import { ChevronRightIcon, PlusIcon } from 'lucide-react'
import { AgentRow } from './agent-row'
import type { OverviewGroup } from './overview'

interface ProjectGroupProps {
  readonly group: OverviewGroup
  readonly open: boolean
  readonly narrowing: boolean
  readonly dragging: boolean
  readonly visibleTab: PaneId | null
  readonly renaming: PaneId | null
  readonly tabStop: string | null
  readonly onToggle: () => void
  readonly onRename: (paneId: PaneId | null) => void
  readonly onRemove: () => void
}

/**
 * One project in the overview: a header that toggles the group, carries the project menu and is
 * the drag handle, then the project's agent rows while the group is open.
 */
export function ProjectGroup({
  group,
  open,
  narrowing,
  dragging,
  visibleTab,
  renaming,
  tabStop,
  onToggle,
  onRename,
  onRemove
}: ProjectGroupProps) {
  const { project } = group
  const sortable = useSortable({ id: project.projectId })
  const count = narrowing ? `${group.shown} of ${group.total}` : String(group.total)
  const showRows = open && !dragging
  const urgent = group.mostUrgent
  return (
    <section
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition
      }}
      aria-label={project.displayName}
      className={cn('flex flex-col', sortable.isDragging && 'relative z-10 opacity-80')}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* biome-ignore lint/a11y/useSemanticElements: the header holds the New agent button, which a <button> cannot contain */}
          <div
            ref={sortable.setActivatorNodeRef}
            data-nav={`header:${project.projectId}`}
            {...sortable.attributes}
            role="button"
            tabIndex={tabStop === `header:${project.projectId}` ? 0 : -1}
            {...sortable.listeners}
            aria-roledescription="sortable project"
            aria-expanded={open}
            aria-label={`${project.displayName}, ${count} agents${urgent === null || open ? '' : `, ${statusLabel(urgent)}`}`}
            onClick={onToggle}
            onKeyDown={(event) => {
              sortable.listeners?.onKeyDown?.(event)
              if (event.defaultPrevented) return
              if (event.key === 'Enter') {
                event.preventDefault()
                onToggle()
              }
            }}
            className={cn(
              'group/header flex h-8 cursor-default items-center gap-1.5 rounded-md pr-1 pl-1.5 outline-none transition-colors duration-150 ease-out hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
              sortable.isDragging && 'bg-secondary ring-2 ring-ring'
            )}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                'size-3.5 shrink-0 text-ink-muted transition-transform duration-150 ease-out motion-reduce:transition-none',
                open && 'rotate-90'
              )}
            />
            <span className="truncate text-sm font-medium text-ink">{project.displayName}</span>
            {project.isGitRepo && (
              <span className="shrink-0 rounded-sm border border-border px-1 font-mono text-[0.6875rem] leading-4 text-ink-muted">
                git
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`New agent in ${project.displayName}`}
                tabIndex={-1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  actions.newAgent(project.projectId)
                }}
                className="opacity-0 group-focus-within/header:opacity-100 group-hover/header:opacity-100"
              >
                <PlusIcon />
              </Button>
              {!open && urgent !== null && <StatusIndicator status={urgent} />}
              <span className="min-w-4 text-right text-xs tabular-nums text-ink-muted">
                {count}
              </span>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuGroup>
            <ContextMenuItem onSelect={() => actions.newAgent(project.projectId)}>
              New agent
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void actions.revealProject(project.directory)}>
              Reveal in Explorer
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem variant="destructive" onSelect={onRemove}>
              Remove project…
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      {showRows && (
        <div className="flex flex-col pb-1">
          {group.rows.map((row) => (
            <AgentRow
              key={row.paneId}
              row={row}
              projectName={project.displayName}
              selected={row.paneId === visibleTab}
              renaming={row.paneId === renaming}
              tabbable={tabStop === `row:${row.paneId}`}
              onRename={(next) => onRename(next ? row.paneId : null)}
            />
          ))}
          {group.archived.length > 0 && (
            <>
              <p className="pt-1 pl-7 text-xs text-ink-muted">Archived · {group.archived.length}</p>
              {group.archived.map((row) => (
                <AgentRow
                  key={row.paneId}
                  row={row}
                  projectName={project.displayName}
                  selected={false}
                  renaming={row.paneId === renaming}
                  tabbable={tabStop === `row:${row.paneId}`}
                  onRename={(next) => onRename(next ? row.paneId : null)}
                />
              ))}
            </>
          )}
          {group.total === 0 && !narrowing && (
            <div className="flex items-center gap-2 py-1 pl-7">
              <span className="text-xs text-ink-muted">No agents</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => actions.newAgent(project.projectId)}
              >
                <PlusIcon data-icon="inline-start" />
                New agent
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
