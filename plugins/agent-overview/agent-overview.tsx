import {
  actions,
  Button,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useAgentSummaries,
  useSidebar,
  useWorkspace
} from '@dia/renderer-plugin'
import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import type { PaneId } from '@shared/domain/pane'
import { ProjectId, type RegisterProjectRefusal, type Workspace } from '@shared/domain/project'
import { Option, Schema } from 'effect'
import { FolderPlusIcon, SearchIcon } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { FilterPopover } from './filter-popover'
import {
  buildOverview,
  filtersApply,
  headerKey,
  type NavigationTarget,
  NO_FILTERS,
  navigationOrder,
  type OverviewFilters,
  type OverviewGroup,
  rowKey,
  STATUS_TAGS,
  type StatusTag
} from './overview'
import { ProjectGroup } from './project-group'
import { RemoveProjectDialog } from './remove-project-dialog'

const COLLAPSED_KEY = 'dia.agent-overview.collapsed'

const decodeCollapsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ProjectId)))

const readCollapsed = (): ReadonlySet<ProjectId> =>
  new Set(Option.getOrElse(decodeCollapsed(localStorage.getItem(COLLAPSED_KEY) ?? '[]'), () => []))

const navKey = (target: NavigationTarget): string =>
  target._tag === 'HeaderTarget' ? headerKey(target.projectId) : rowKey(target.paneId)

const NO_COLLAPSED: ReadonlySet<ProjectId> = new Set()

const focusNav = (container: HTMLElement, key: string): void =>
  container.querySelector<HTMLElement>(`[data-nav="${key}"]`)?.focus()

const REFUSAL_TEXT: Record<RegisterProjectRefusal['_tag'], string> = {
  ProjectAlreadyRegisteredError: 'dia already has a project for that directory.',
  DirectoryNotFoundError: 'That directory no longer exists.'
}

const statusCounts = (workspace: Workspace, summaries: ReturnType<typeof useAgentSummaries>) => {
  const counts = Object.fromEntries(STATUS_TAGS.map((tag) => [tag, 0])) as Record<StatusTag, number>
  for (const entry of workspace.projects) {
    for (const tab of entry.tabs) {
      if (tab.archived) continue
      counts[summaries.get(tab.config.paneId)?.status._tag ?? 'StatusIdle'] += 1
    }
  }
  return counts
}

const orderGroups = (
  groups: ReadonlyArray<OverviewGroup>,
  order: ReadonlyArray<ProjectId> | null
): ReadonlyArray<OverviewGroup> =>
  order === null
    ? groups
    : [...groups].sort(
        (a, b) => order.indexOf(a.project.projectId) - order.indexOf(b.project.projectId)
      )

/** The shortcuts the overview answers anywhere in the window. */
const useWindowShortcuts = (onSearch: () => void): void => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        onSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSearch])
}

function Kbd({ children }: { readonly children: React.ReactNode }) {
  return (
    <kbd className="pointer-events-none rounded-sm border border-border px-1 font-sans text-[0.6875rem] leading-4 text-ink-muted">
      {children}
    </kbd>
  )
}

function MetaMarker() {
  return <span aria-hidden className="size-2 shrink-0 rounded-[2px] bg-primary/60" />
}

function MetaGroup() {
  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip="Meta · No open proposals"
            className="cursor-default group-data-[collapsible=icon]:justify-center"
          >
            <div>
              <span className="sr-only">Meta, no open proposals</span>
              <MetaMarker />
              <span
                aria-hidden
                className="text-sm font-medium text-ink group-data-[collapsible=icon]:hidden"
              >
                Meta
              </span>
              <span
                aria-hidden
                className="ml-auto text-xs text-ink-muted group-data-[collapsible=icon]:hidden"
              >
                No open proposals
              </span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}

function NoProjects({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-4">
      <p className="text-sm text-ink">No projects yet</p>
      <p className="text-xs text-ink-muted">
        Add a directory to run agents in it. dia never changes the directory itself.
      </p>
      <Button size="sm" variant="outline" onClick={onAdd}>
        <FolderPlusIcon data-icon="inline-start" />
        Add project
      </Button>
    </div>
  )
}

function NoMatches({
  filters,
  onClear
}: {
  readonly filters: OverviewFilters
  readonly onClear: () => void
}) {
  const query = filters.query.trim()
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-4">
      <p className="text-sm text-ink">
        {query === ''
          ? 'No agents match these filters.'
          : `No agents or projects match "${query}".`}
      </p>
      <Button size="xs" variant="outline" onClick={onClear}>
        Clear search and filters
      </Button>
    </div>
  )
}

/**
 * The agent overview sidebar: search, filters and add-project in its header, the Meta group, then
 * every registered project as a collapsible, reorderable group of agent rows. Render it inside a
 * `SidebarProvider`. `Ctrl P` expands the sidebar and focuses the search; while the sidebar is
 * collapsed it shows Meta and one status dot per agent.
 */
export function AgentOverview() {
  const workspace = useWorkspace()
  const summaries = useAgentSummaries()
  const { state, setOpen } = useSidebar()
  const iconMode = state === 'collapsed'
  const [filters, setFilters] = useState<OverviewFilters>(NO_FILTERS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<ProjectId>>(readCollapsed)
  const [dragging, setDragging] = useState(false)
  const [dragOrder, setDragOrder] = useState<{
    readonly workspace: typeof workspace
    readonly ids: ReadonlyArray<ProjectId>
  } | null>(null)
  const order = dragOrder !== null && dragOrder.workspace === workspace ? dragOrder.ids : null
  const [renaming, setRenaming] = useState<PaneId | null>(null)
  const [removing, setRemoving] = useState<ProjectId | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tabStop, setTabStop] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLElement>(null)

  useEffect(() => localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])), [collapsed])

  const focusSearch = () => {
    setOpen(true)
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  useWindowShortcuts(focusSearch)

  const activeFilters = iconMode ? NO_FILTERS : filters
  const narrowing = filtersApply(activeFilters)
  const groups = useMemo(
    () =>
      workspace === undefined
        ? []
        : orderGroups(buildOverview(workspace, summaries, activeFilters), order),
    [workspace, summaries, activeFilters, order]
  )
  const effectiveCollapsed = narrowing || iconMode ? NO_COLLAPSED : collapsed
  const targets = useMemo(
    () =>
      navigationOrder(groups, effectiveCollapsed).filter(
        (target) => !iconMode || target._tag === 'RowTarget'
      ),
    [groups, effectiveCollapsed, iconMode]
  )
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] }
    })
  )

  if (workspace === undefined) return <Sidebar collapsible="icon" />

  const nameOf = (id: string | number): string =>
    workspace.projects.find((entry) => entry.project.projectId === id)?.project.displayName ??
    String(id)
  const positionOf = (id: string | number): number =>
    groups.findIndex((group) => group.project.projectId === id) + 1
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}, position ${positionOf(active.id)} of ${groups.length}.`,
    onDragOver: ({ active, over }) =>
      over === null
        ? `${nameOf(active.id)} is not over a position.`
        : `${nameOf(active.id)} moved to position ${positionOf(over.id)} of ${groups.length}.`,
    onDragEnd: ({ active, over }) =>
      over === null
        ? `${nameOf(active.id)} dropped. The order is unchanged.`
        : `${nameOf(active.id)} dropped at position ${positionOf(over.id)} of ${groups.length}.`,
    onDragCancel: ({ active }) =>
      `Moving ${nameOf(active.id)} was cancelled. The order is unchanged.`
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false)
    if (over === null || active.id === over.id) return
    const ids = workspace.projects.map((entry) => entry.project.projectId)
    const from = ids.indexOf(active.id as ProjectId)
    const to = ids.indexOf(over.id as ProjectId)
    if (from === -1 || to === -1) return
    setDragOrder({ workspace, ids: arrayMove(ids, from, to) })
    actions.moveProject(ids[from], to)
  }

  const toggle = (projectId: ProjectId) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })

  const addProject = () => {
    setNotice(null)
    actions.registerProject().then(
      (refusal) => setNotice(refusal == null ? null : REFUSAL_TEXT[refusal._tag]),
      () => setNotice('The project could not be added. Try again.')
    )
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (dragging || renaming !== null || listRef.current === null) return
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-nav]')?.dataset.nav
    if (current === undefined) return
    const index = targets.findIndex((target) => navKey(target) === current)
    const target = targets[index]
    if (target === undefined) return
    const move = (offset: number) => {
      const next = targets[index + offset]
      if (next !== undefined) focusNav(listRef.current as HTMLElement, navKey(next))
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'ArrowRight':
        if (target._tag === 'HeaderTarget' && effectiveCollapsed.has(target.projectId)) {
          event.preventDefault()
          toggle(target.projectId)
        }
        break
      case 'ArrowLeft': {
        event.preventDefault()
        if (target._tag === 'HeaderTarget') {
          if (!effectiveCollapsed.has(target.projectId) && !narrowing) toggle(target.projectId)
          break
        }
        const header = targets
          .slice(0, index)
          .reverse()
          .find((candidate) => candidate._tag === 'HeaderTarget')
        if (header !== undefined) focusNav(listRef.current, navKey(header))
        break
      }
    }
  }

  const currentStop =
    tabStop !== null && targets.some((target) => navKey(target) === tabStop)
      ? tabStop
      : targets[0] === undefined
        ? null
        : navKey(targets[0])

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && filters.query !== '') {
      event.preventDefault()
      setFilters({ ...filters, query: '' })
      return
    }
    if (listRef.current === null) return
    if (event.key === 'ArrowDown' && targets[0] !== undefined) {
      event.preventDefault()
      focusNav(listRef.current, navKey(targets[0]))
    }
    const firstRow = targets.find((target) => target._tag === 'RowTarget')
    if (event.key === 'Enter' && filters.query.trim() !== '' && firstRow !== undefined) {
      event.preventDefault()
      actions.selectTab(firstRow.paneId)
      focusNav(listRef.current, navKey(firstRow))
    }
  }

  const removingEntry =
    removing === null
      ? undefined
      : workspace.projects.find((entry) => entry.project.projectId === removing)
  const shownGroups = iconMode ? groups.filter((group) => group.rows.length > 0) : groups

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="pt-0">
          <div className="titlebar-drag flex h-8 items-center px-2 text-sm font-semibold tracking-tight text-ink select-none">
            {!iconMode && 'dia'}
          </div>
          {!iconMode && (
            <>
              <div className="flex items-center gap-1">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-muted"
                  />
                  <SidebarInput
                    ref={searchRef}
                    type="search"
                    aria-label="Search agents and projects"
                    placeholder="Search"
                    value={filters.query}
                    onChange={(event) => setFilters({ ...filters, query: event.target.value })}
                    onKeyDown={onSearchKeyDown}
                    className="pr-12 pl-7 text-sm [&::-webkit-search-cancel-button]:hidden"
                  />
                  <span className="absolute top-1/2 right-2 -translate-y-1/2">
                    <Kbd>Ctrl P</Kbd>
                  </span>
                </div>
                <FilterPopover
                  filters={filters}
                  counts={statusCounts(workspace, summaries)}
                  onChange={setFilters}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Add project"
                      onClick={addProject}
                    >
                      <FolderPlusIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add project</TooltipContent>
                </Tooltip>
              </div>
              {notice !== null && (
                <p role="status" className="text-xs text-error">
                  {notice}
                </p>
              )}
            </>
          )}
        </SidebarHeader>

        <SidebarContent className="group-data-[collapsible=icon]:overflow-x-hidden group-data-[collapsible=icon]:overflow-y-auto">
          <nav
            ref={listRef}
            aria-label="Projects and agents"
            className="contents"
            onKeyDown={onListKeyDown}
            onFocus={(event) => {
              const key = event.target.closest<HTMLElement>('[data-nav]')?.dataset.nav
              if (key !== undefined) setTabStop(key)
            }}
          >
            {!narrowing && <MetaGroup />}
            {workspace.projects.length === 0 ? (
              !iconMode && <NoProjects onAdd={addProject} />
            ) : groups.length === 0 ? (
              <NoMatches filters={filters} onClear={() => setFilters(NO_FILTERS)} />
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                accessibility={{
                  announcements,
                  screenReaderInstructions: {
                    draggable:
                      'To move a project, press Space. Press the up and down arrow keys to move it, Space to drop it, or Escape to cancel.'
                  }
                }}
                onDragStart={() => setDragging(true)}
                onDragCancel={() => setDragging(false)}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={groups.map((group) => group.project.projectId)}
                  strategy={verticalListSortingStrategy}
                >
                  {shownGroups.map((group) => (
                    <Fragment key={group.project.projectId}>
                      {iconMode && <SidebarSeparator />}
                      <ProjectGroup
                        group={group}
                        open={!effectiveCollapsed.has(group.project.projectId)}
                        narrowing={narrowing}
                        dragging={dragging}
                        iconMode={iconMode}
                        visibleTab={workspace.visibleTab}
                        renaming={renaming}
                        tabStop={currentStop}
                        onToggle={() => toggle(group.project.projectId)}
                        onRename={setRenaming}
                        onRemove={() => setRemoving(group.project.projectId)}
                      />
                    </Fragment>
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </nav>
        </SidebarContent>
        <SidebarRail className="titlebar-no-drag" />
      </Sidebar>

      {removingEntry !== undefined && (
        <RemoveProjectDialog
          key={removingEntry.project.projectId}
          entry={removingEntry}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}
