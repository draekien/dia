import {
  actions,
  Button,
  cn,
  Input,
  ScrollArea,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useAgentSummaries,
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
import { FolderPlusIcon, PanelLeftCloseIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FilterPopover } from './filter-popover'
import {
  buildOverview,
  filtersApply,
  type NavigationTarget,
  NO_FILTERS,
  navigationOrder,
  type OverviewFilters,
  type OverviewGroup,
  STATUS_TAGS,
  type StatusTag
} from './overview'
import { ProjectGroup } from './project-group'
import { MetaMarker, Rail } from './rail'
import { RemoveProjectDialog } from './remove-project-dialog'

const COLLAPSED_KEY = 'dia.agent-overview.collapsed'
const RAIL_KEY = 'dia.agent-overview.rail'

const decodeCollapsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ProjectId)))

const readCollapsed = (): ReadonlySet<ProjectId> =>
  new Set(Option.getOrElse(decodeCollapsed(localStorage.getItem(COLLAPSED_KEY) ?? '[]'), () => []))

const navKey = (target: NavigationTarget): string =>
  target._tag === 'HeaderTarget' ? `header:${target.projectId}` : `row:${target.paneId}`

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
const useWindowShortcuts = (onSearch: () => void, onToggleRail: () => void): void => {
  const handlers = useRef({ onSearch, onToggleRail })
  handlers.current = { onSearch, onToggleRail }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        handlers.current.onSearch()
      }
      if (event.key.toLowerCase() === 'b') {
        event.preventDefault()
        handlers.current.onToggleRail()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function Kbd({ children }: { readonly children: React.ReactNode }) {
  return (
    <kbd className="pointer-events-none rounded-sm border border-border px-1 font-sans text-[0.6875rem] leading-4 text-ink-muted">
      {children}
    </kbd>
  )
}

function MetaGroup() {
  return (
    <div className="flex h-8 items-center gap-1.5 pr-1 pl-1.5">
      <MetaMarker />
      <span className="text-sm font-medium text-ink">Meta</span>
      <span className="ml-auto text-xs text-ink-muted">No open proposals</span>
    </div>
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
 * every registered project as a collapsible, reorderable group of agent rows. `Ctrl P` focuses
 * the search and `Ctrl B` collapses it to the status rail.
 */
export function AgentOverview() {
  const workspace = useWorkspace()
  const summaries = useAgentSummaries()
  const [filters, setFilters] = useState<OverviewFilters>(NO_FILTERS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<ProjectId>>(readCollapsed)
  const [rail, setRail] = useState(() => localStorage.getItem(RAIL_KEY) === '1')
  const [dragging, setDragging] = useState(false)
  const [order, setOrder] = useState<ReadonlyArray<ProjectId> | null>(null)
  const [renaming, setRenaming] = useState<PaneId | null>(null)
  const [removing, setRemoving] = useState<ProjectId | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tabStop, setTabStop] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLElement>(null)

  useEffect(() => localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])), [collapsed])
  useEffect(() => localStorage.setItem(RAIL_KEY, rail ? '1' : '0'), [rail])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the optimistic order lasts until the next workspace arrives
  useEffect(() => setOrder(null), [workspace])

  const focusSearch = () => {
    setRail(false)
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  useWindowShortcuts(focusSearch, () => setRail((current) => !current))

  const narrowing = filtersApply(filters)
  const groups = useMemo(
    () =>
      workspace === undefined
        ? []
        : orderGroups(buildOverview(workspace, summaries, filters), order),
    [workspace, summaries, filters, order]
  )
  const effectiveCollapsed = narrowing ? new Set<ProjectId>() : collapsed
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] }
    })
  )

  if (workspace === undefined) return <aside aria-label="Agents" className="w-72 shrink-0" />

  if (rail) {
    const allGroups = buildOverview(workspace, summaries, NO_FILTERS)
    return (
      <Rail groups={allGroups} visibleTab={workspace.visibleTab} onExpand={() => setRail(false)} />
    )
  }

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
    setOrder(arrayMove(ids, from, to))
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

  const targets = navigationOrder(groups, effectiveCollapsed)
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

  return (
    <aside aria-label="Agents" className="flex w-72 shrink-0 flex-col">
      <div className="flex items-center gap-1 p-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-muted"
          />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search agents and projects"
            placeholder="Search"
            value={filters.query}
            onChange={(event) => setFilters({ ...filters, query: event.target.value })}
            onKeyDown={onSearchKeyDown}
            className="h-8 pr-12 pl-7 text-sm [&::-webkit-search-cancel-button]:hidden"
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
            <Button variant="ghost" size="icon-sm" aria-label="Add project" onClick={addProject}>
              <FolderPlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add project</TooltipContent>
        </Tooltip>
      </div>
      {notice !== null && (
        <p role="status" className="px-3 pb-2 text-xs text-error">
          {notice}
        </p>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <nav
          ref={listRef}
          aria-label="Projects and agents"
          className="flex flex-col px-2 pb-2"
          onKeyDown={onListKeyDown}
          onFocus={(event) => {
            const key = event.target.closest<HTMLElement>('[data-nav]')?.dataset.nav
            if (key !== undefined) setTabStop(key)
          }}
        >
          {!narrowing && (
            <>
              <MetaGroup />
              <Separator className="my-1" />
            </>
          )}
          {workspace.projects.length === 0 ? (
            <NoProjects onAdd={addProject} />
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
                {groups.map((group, index) => (
                  <div
                    key={group.project.projectId}
                    className={cn(index > 0 && 'border-t border-border/60 pt-1', 'mt-1')}
                  >
                    <ProjectGroup
                      group={group}
                      open={!effectiveCollapsed.has(group.project.projectId)}
                      narrowing={narrowing}
                      dragging={dragging}
                      visibleTab={workspace.visibleTab}
                      renaming={renaming}
                      tabStop={currentStop}
                      onToggle={() => toggle(group.project.projectId)}
                      onRename={setRenaming}
                      onRemove={() => setRemoving(group.project.projectId)}
                    />
                  </div>
                ))}
              </SortableContext>
            </DndContext>
          )}
        </nav>
      </ScrollArea>

      <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => setRail(true)} className="text-ink-muted">
          <PanelLeftCloseIcon data-icon="inline-start" />
          Collapse
        </Button>
        <Kbd>Ctrl B</Kbd>
      </div>

      {removingEntry !== undefined && (
        <RemoveProjectDialog
          key={removingEntry.project.projectId}
          entry={removingEntry}
          onClose={() => setRemoving(null)}
        />
      )}
    </aside>
  )
}
