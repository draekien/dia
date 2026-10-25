import {
  type AgentStatus,
  type AgentSummary,
  NoActivity,
  StatusFailed,
  StatusFinished,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking
} from '@shared/domain/agent-summary'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import { describe, expect, it } from 'vitest'
import {
  buildOverview,
  HeaderTarget,
  NO_FILTERS,
  navigationOrder,
  type OverviewFilters,
  RowTarget
} from './overview'

const projectId = (n: number) => ProjectId.make(`00000000-0000-4000-8000-00000000000${n}`)
const paneId = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`

const tab = (n: number, name: string, archived = false): Tab => ({
  name: AgentName.make(name),
  config: {
    paneId: paneId(n),
    cwd: '/repo',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived
})

const project = (n: number, displayName: string, tabs: ReadonlyArray<Tab>) => ({
  project: {
    projectId: projectId(n),
    directory: `/${displayName}`,
    directoryKey: `/${displayName}`,
    displayName,
    isGitRepo: true
  },
  tabs
})

const summary = (n: number, status: AgentStatus): AgentSummary => ({
  paneId: paneId(n),
  status,
  activity: NoActivity.make({})
})

const summaries = (...entries: ReadonlyArray<AgentSummary>) =>
  new Map(entries.map((entry) => [entry.paneId, entry]))

const names = (workspace: Workspace, map: Map<string, AgentSummary>, filters = NO_FILTERS) =>
  buildOverview(workspace, map, filters).map((group) => [
    group.project.displayName,
    group.rows.map((row) => row.name)
  ])

const filters = (patch: Partial<OverviewFilters>): OverviewFilters => ({ ...NO_FILTERS, ...patch })

describe('buildOverview', () => {
  const workspace: Workspace = {
    projects: [
      project(1, 'dia', [
        tab(1, 'idle-one'),
        tab(2, 'finished-one'),
        tab(3, 'working-one'),
        tab(4, 'failed-one'),
        tab(5, 'asking-one')
      ]),
      project(2, 'dia-site', [tab(6, 'deploy-preview'), tab(7, 'rewind-lab')])
    ],
    visibleTab: null
  }
  const statuses = summaries(
    summary(1, StatusIdle.make({})),
    summary(2, StatusFinished.make({})),
    summary(3, StatusWorking.make({})),
    summary(4, StatusFailed.make({ reason: 'exit 1' })),
    summary(5, StatusNeedsInput.make({ reason: 'Allow Bash?' })),
    summary(6, StatusIdle.make({})),
    summary(7, StatusFailed.make({ reason: 'exit 2' }))
  )

  it('sorts rows needs input, failed, working, finished, idle inside a group', () => {
    expect(names(workspace, statuses)[0]).toEqual([
      'dia',
      ['asking-one', 'failed-one', 'working-one', 'finished-one', 'idle-one']
    ])
  })

  it('keeps the project order when a later project holds a more urgent agent', () => {
    const urgentLater = summaries(
      summary(1, StatusIdle.make({})),
      summary(6, StatusNeedsInput.make({ reason: 'Allow Bash?' }))
    )

    expect(names(workspace, urgentLater).map(([name]) => name)).toEqual(['dia', 'dia-site'])
  })

  it('keeps creation order between agents with the same status', () => {
    const allIdle = summaries()

    expect(names(workspace, allIdle)[1]).toEqual(['dia-site', ['deploy-preview', 'rewind-lab']])
  })

  it('reports the most urgent status and the agent count of each group', () => {
    const [dia, site] = buildOverview(workspace, statuses, NO_FILTERS)

    expect([dia.mostUrgent?._tag, dia.total]).toEqual(['StatusNeedsInput', 5])
    expect([site.mostUrgent?._tag, site.total]).toEqual(['StatusFailed', 2])
  })

  it('reports no urgent status for a project with no agents', () => {
    const empty: Workspace = { projects: [project(3, 'notes', [])], visibleTab: null }

    expect(buildOverview(empty, summaries(), NO_FILTERS)[0].mostUrgent).toBeNull()
  })

  it('matches the query against agent names, keeping the matching rows under their project', () => {
    expect(names(workspace, statuses, filters({ query: 'REWIND' }))).toEqual([
      ['dia-site', ['rewind-lab']]
    ])
  })

  it('shows every agent of a project whose name matches the query', () => {
    expect(names(workspace, statuses, filters({ query: 'site' }))).toEqual([
      ['dia-site', ['rewind-lab', 'deploy-preview']]
    ])
  })

  it('combines the query and the status filter with AND', () => {
    const narrowed = filters({ query: 'one', statuses: ['StatusFailed', 'StatusIdle'] })

    expect(names(workspace, statuses, narrowed)).toEqual([['dia', ['failed-one', 'idle-one']]])
  })

  it('counts the shown rows against all agents while a filter applies', () => {
    const [dia] = buildOverview(workspace, statuses, filters({ statuses: ['StatusWorking'] }))

    expect([dia.shown, dia.total]).toEqual([1, 5])
  })

  it('keeps an unmatched project, with no rows, when hiding unmatched projects is off', () => {
    const narrowed = filters({ query: 'rewind', hideUnmatchedProjects: false })

    expect(names(workspace, statuses, narrowed)).toEqual([
      ['dia', []],
      ['dia-site', ['rewind-lab']]
    ])
  })

  it('lists archived agents only when showArchived is on', () => {
    const withArchived: Workspace = {
      projects: [project(1, 'dia', [tab(1, 'live'), tab(2, 'old', true)])],
      visibleTab: null
    }

    const hidden = buildOverview(withArchived, summaries(), NO_FILTERS)[0]
    const shown = buildOverview(withArchived, summaries(), filters({ showArchived: true }))[0]

    expect([hidden.archived.length, hidden.total]).toEqual([0, 1])
    expect(shown.archived.map((row) => row.name)).toEqual(['old'])
  })
})

describe('navigationOrder', () => {
  const workspace: Workspace = {
    projects: [project(1, 'dia', [tab(1, 'a'), tab(2, 'b')]), project(2, 'site', [tab(3, 'c')])],
    visibleTab: null
  }
  const groups = buildOverview(workspace, summaries(), NO_FILTERS)

  it('moves through each header followed by its rows', () => {
    expect(navigationOrder(groups, new Set())).toEqual([
      HeaderTarget.make({ projectId: projectId(1) }),
      RowTarget.make({ paneId: paneId(1) }),
      RowTarget.make({ paneId: paneId(2) }),
      HeaderTarget.make({ projectId: projectId(2) }),
      RowTarget.make({ paneId: paneId(3) })
    ])
  })

  it('skips the rows of a collapsed group', () => {
    expect(navigationOrder(groups, new Set([projectId(1)]))).toEqual([
      HeaderTarget.make({ projectId: projectId(1) }),
      HeaderTarget.make({ projectId: projectId(2) }),
      RowTarget.make({ paneId: paneId(3) })
    ])
  })
})
