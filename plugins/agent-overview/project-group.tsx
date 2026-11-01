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
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  StatusIndicator,
  statusLabel
} from '@dia/renderer-plugin'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PaneId } from '@shared/domain/pane'
import { ChevronRightIcon, PlusIcon } from 'lucide-react'
import { AgentRow } from './agent-row'
import { archivedKey, headerKey, type OverviewGroup, type OverviewRow, rowKey } from './overview'
import type { Retirement } from './retire-agent-dialog'

interface ProjectGroupProps {
  readonly group: OverviewGroup
  readonly open: boolean
  readonly archivedOpen: boolean
  readonly narrowing: boolean
  readonly dragging: boolean
  readonly iconMode: boolean
  readonly visibleTab: PaneId | null
  readonly renaming: PaneId | null
  readonly tabStop: string | null
  readonly onToggle: () => void
  readonly onToggleArchived: () => void
  readonly onRename: (paneId: PaneId | null) => void
  readonly onRetire: (paneId: PaneId, retirement: Retirement) => void
  readonly onRemove: () => void
}

/**
 * One project in the overview: a header that toggles the group, carries the project menu and is
 * the drag handle, then the project's agent rows while the group is open, ending with a toggle
 * that opens the list of its archived agents.
 */
export function ProjectGroup({
  group,
  open,
  archivedOpen,
  narrowing,
  dragging,
  iconMode,
  visibleTab,
  renaming,
  tabStop,
  onToggle,
  onToggleArchived,
  onRename,
  onRetire,
  onRemove
}: ProjectGroupProps) {
  const { project } = group
  const {
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    attributes,
    listeners
  } = useSortable({ id: project.projectId, disabled: iconMode })
  const count = narrowing ? `${group.shown} of ${group.total}` : String(group.total)
  const showRows = open && !dragging
  const urgent = group.mostUrgent
  const renderRow = (row: OverviewRow, archived: boolean) => (
    <AgentRow
      key={row.paneId}
      row={row}
      projectName={project.displayName}
      selected={row.paneId === visibleTab}
      renaming={row.paneId === renaming}
      tabbable={tabStop === rowKey(row.paneId)}
      archived={archived}
      onRename={(next) => onRename(next ? row.paneId : null)}
      onRetire={(retirement) => onRetire(row.paneId, retirement)}
    />
  )
  return (
    <SidebarGroup
      ref={setNodeRef}
      role="group"
      style={{
        transform: CSS.Translate.toString(transform),
        transition
      }}
      aria-label={project.displayName}
      className={cn('group/project', isDragging && 'relative z-10 opacity-80')}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarGroupLabel asChild>
            <button
              type="button"
              ref={setActivatorNodeRef}
              data-nav={headerKey(project.projectId)}
              {...attributes}
              tabIndex={tabStop === headerKey(project.projectId) ? 0 : -1}
              {...listeners}
              aria-roledescription="sortable project"
              aria-expanded={open}
              aria-label={`${project.displayName}, ${count} ${group.total === 1 ? 'agent' : 'agents'}${urgent === null || open ? '' : `, ${statusLabel(urgent)}`}`}
              onClick={onToggle}
              onKeyDown={(event) => listeners?.onKeyDown?.(event)}
              className={cn(
                'w-full cursor-default gap-1.5 pr-8 pl-1.5 text-left hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden',
                isDragging && 'bg-sidebar-accent ring-2 ring-sidebar-ring'
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
                {!open && urgent !== null && <StatusIndicator status={urgent} />}
                <span className="min-w-4 text-right text-xs tabular-nums text-ink-muted">
                  {count}
                </span>
              </span>
            </button>
          </SidebarGroupLabel>
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
              Remove project
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      <SidebarGroupAction
        tabIndex={-1}
        aria-label={`New agent in ${project.displayName}`}
        onClick={() => actions.newAgent(project.projectId)}
        className="opacity-0 group-focus-within/project:opacity-100 group-hover/project:opacity-100"
      >
        <PlusIcon />
      </SidebarGroupAction>
      {showRows && (
        <SidebarGroupContent>
          <SidebarMenu className="gap-0">
            {group.rows.map((row) => renderRow(row, false))}
            {group.total === 0 && !narrowing && (
              <li className="flex list-none items-center gap-2 py-1 pl-2">
                <span className="text-xs text-ink-muted">No agents</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => actions.newAgent(project.projectId)}
                >
                  <PlusIcon data-icon="inline-start" />
                  New agent
                </Button>
              </li>
            )}
            {group.archived.length > 0 && !iconMode && (
              <>
                <li className="list-none">
                  <button
                    type="button"
                    data-nav={archivedKey(project.projectId)}
                    tabIndex={tabStop === archivedKey(project.projectId) ? 0 : -1}
                    aria-expanded={archivedOpen}
                    onClick={onToggleArchived}
                    className="flex w-full cursor-default items-center gap-1 rounded-md py-1 pl-2 text-left text-xs text-ink-muted outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        'size-3 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none',
                        archivedOpen && 'rotate-90'
                      )}
                    />
                    Archived ({group.archived.length})
                  </button>
                </li>
                {archivedOpen && group.archived.map((row) => renderRow(row, true))}
              </>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}
