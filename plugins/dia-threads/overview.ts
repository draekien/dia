import { type PaneId, PermissionMode } from '@shared/domain/pane'
import { Project, ProjectId, type Workspace } from '@shared/domain/project'
import {
  idleSummary,
  NoActivity,
  RunSummary,
  RunSummaryStatus,
  statusRank
} from '@shared/domain/run-summary'
import { Uuid } from '@shared/domain/uuid'
import { userProjects } from '@shared/domain/workspace'
import { Schema } from 'effect'

/** The `_tag` of an {@link RunSummaryStatus}, as a status filter names it. */
export const StatusTag = Schema.Literals([
  'StatusNeedsInput',
  'StatusFailed',
  'StatusParked',
  'StatusWorking',
  'StatusFinished',
  'StatusIdle'
])
export type StatusTag = typeof StatusTag.Type

/** Every status tag, most urgent first, as the filter popover lists them. */
export const STATUS_TAGS: ReadonlyArray<StatusTag> = StatusTag.literals

/**
 * What the overview shows. `query` matches agent and project names, case-insensitively.
 * `statuses` keeps rows whose status is one of them; empty keeps every status. Query and statuses
 * combine with AND. `hideUnmatchedProjects` drops a project with no matching row while the query
 * or a status filter applies.
 */
export const OverviewFilters = Schema.Struct({
  query: Schema.String,
  statuses: Schema.Array(StatusTag),
  hideUnmatchedProjects: Schema.Boolean
})
export type OverviewFilters = typeof OverviewFilters.Type

/** The filters before the user changes any: everything shown, unmatched projects hidden. */
export const NO_FILTERS: OverviewFilters = OverviewFilters.make({
  query: '',
  statuses: [],
  hideUnmatchedProjects: true
})

/** Whether the query or a status filter narrows the overview; group counts then read `n of total`. */
export const filtersApply = (filters: OverviewFilters): boolean =>
  filters.query.trim() !== '' || filters.statuses.length > 0

/** One agent row: its pane id, name and current permission mode, and its current summary. */
export const OverviewRow = Schema.Struct({
  paneId: Uuid,
  name: Schema.String,
  summary: RunSummary,
  permissionMode: PermissionMode
})
export type OverviewRow = typeof OverviewRow.Type

/**
 * One project group. `rows` are the matching open agents, most urgent first and then in creation
 * order. `mostUrgent` is the most urgent status among all the project's open agents. `shown`
 * counts `rows`; `total` counts every open agent. An open agent is a tab that is not archived.
 */
export const OverviewGroup = Schema.Struct({
  project: Project,
  rows: Schema.Array(OverviewRow),
  mostUrgent: Schema.NullOr(RunSummaryStatus),
  shown: Schema.Int,
  total: Schema.Int
})
export type OverviewGroup = typeof OverviewGroup.Type

const byUrgency = (rows: ReadonlyArray<OverviewRow>): ReadonlyArray<OverviewRow> =>
  rows
    .map((row, order) => ({ row, order }))
    .sort(
      (a, b) =>
        statusRank(a.row.summary.status) - statusRank(b.row.summary.status) || a.order - b.order
    )
    .map(({ row }) => row)

const mostUrgentOf = (rows: ReadonlyArray<OverviewRow>): RunSummaryStatus | null =>
  rows.reduce<RunSummaryStatus | null>(
    (best, row) =>
      best === null || statusRank(row.summary.status) < statusRank(best)
        ? row.summary.status
        : best,
    null
  )

const contains = (text: string, query: string): boolean => text.toLocaleLowerCase().includes(query)

/**
 * The project groups the overview lists, in the user's project order, with their rows filtered
 * by `filters`. A project with no open thread (a tab that is not archived and has no `owner`) is
 * not listed, whatever the filters. A status change reorders rows inside a group but never moves
 * a group. A tab with no summary yet shows as idle with no activity. Tabs and projects a plugin
 * owns are left out: the plugin lists them itself.
 */
export const buildOverview = (
  workspace: Workspace,
  summaries: ReadonlyMap<PaneId, RunSummary>,
  filters: OverviewFilters
): ReadonlyArray<OverviewGroup> => {
  const query = filters.query.trim().toLocaleLowerCase()
  const narrowing = filtersApply(filters)
  return userProjects(workspace).flatMap((owned) => {
    const entry = { ...owned, tabs: owned.tabs.filter((tab) => tab.owner === undefined) }
    const projectMatches = query === '' || contains(entry.project.displayName, query)
    const summaryOf = (paneId: PaneId) =>
      summaries.get(paneId) ?? idleSummary(paneId, NoActivity.make({}))
    const toRow = (tab: (typeof entry.tabs)[number]): OverviewRow =>
      OverviewRow.make({
        paneId: tab.config.paneId,
        name: tab.name,
        summary: summaryOf(tab.config.paneId),
        permissionMode: tab.config.permissionMode
      })
    const matches = (row: OverviewRow): boolean =>
      (projectMatches || contains(row.name, query)) &&
      (filters.statuses.length === 0 || filters.statuses.includes(row.summary.status._tag))
    const active = entry.tabs.filter((tab) => !tab.archived).map(toRow)
    const rows = byUrgency(active.filter(matches))
    if (active.length === 0) return []
    const groupMatches = rows.length > 0 || (filters.statuses.length === 0 && projectMatches)
    if (narrowing && filters.hideUnmatchedProjects && !groupMatches) return []
    return [
      OverviewGroup.make({
        project: entry.project,
        rows,
        mostUrgent: mostUrgentOf(active),
        shown: rows.length,
        total: active.length
      })
    ]
  })
}

/** The `data-nav` key of the header of project `projectId`, which keyboard navigation focuses. */
export const headerKey = (projectId: ProjectId): string => `header:${projectId}`

/** The `data-nav` key of the row of tab `paneId`, which keyboard navigation focuses. */
export const rowKey = (paneId: PaneId): string => `row:${paneId}`

/** Keyboard focus on a project group header. */
export const HeaderTarget = Schema.TaggedStruct('HeaderTarget', { projectId: ProjectId })
export type HeaderTarget = typeof HeaderTarget.Type

/** Keyboard focus on an agent row. */
export const RowTarget = Schema.TaggedStruct('RowTarget', { paneId: Uuid })
export type RowTarget = typeof RowTarget.Type

/** Something the arrow keys move between in the overview. */
export const NavigationTarget = Schema.Union([HeaderTarget, RowTarget])
export type NavigationTarget = typeof NavigationTarget.Type

/**
 * The order `↑` and `↓` move through: each group header, followed, unless the group is in
 * `collapsed`, by its rows. Pass an empty `collapsed` while filters apply, because every group is
 * open then.
 */
export const navigationOrder = (
  groups: ReadonlyArray<OverviewGroup>,
  collapsed: ReadonlySet<ProjectId>
): ReadonlyArray<NavigationTarget> =>
  groups.flatMap(({ project: { projectId }, rows }) => [
    HeaderTarget.make({ projectId }),
    ...(collapsed.has(projectId) ? [] : rows.map((row) => RowTarget.make({ paneId: row.paneId })))
  ])
