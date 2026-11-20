import type { PermissionMode } from '@shared/domain/pane'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import {
  NoActivity,
  type RunSummary,
  type RunSummaryStatus,
  StatusFailed,
  StatusFinished,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking
} from '@shared/domain/run-summary'
import { describe, expect, it } from 'vitest'
import {
  buildMetaRows,
  buildOverview,
  HeaderTarget,
  NO_FILTERS,
  navigationOrder,
  type OverviewFilters,
  RowTarget
} from './overview'

const projectId = (n: number) => ProjectId.make(`00000000-0000-4000-8000-00000000000${n}`)
const paneId = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`

const tab = (
  n: number,
  name: string,
  archived = false,
  permissionMode: PermissionMode = 'default'
): Tab => ({
  name: AgentName.make(name),
  config: {
    paneId: paneId(n),
    cwd: '/repo',
    model: 'm',
    backend: 'dia-claude-code',
    thinkingLevel: 'adaptive',
    permissionMode
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

const summary = (n: number, status: RunSummaryStatus): RunSummary => ({
  paneId: paneId(n),
  status,
  activity: NoActivity.make({})
})

const summaries = (...entries: ReadonlyArray<RunSummary>) =>
  new Map(entries.map((entry) => [entry.paneId, entry]))

const names = (workspace: Workspace, map: Map<string, RunSummary>, filters = NO_FILTERS) =>
  buildOverview(workspace, map, filters).map((group) => [
    group.project.displayName,
    group.rows.map((row) => row.name)
  ])

const filters = (patch: Partial<OverviewFilters>): OverviewFilters => ({ ...NO_FILTERS, ...patch })

describe('buildOverview', () => {
  it('leaves out tabs a plugin owns', () => {
    const owned: Tab = { ...tab(2, 'Fix the anchor'), owner: 'dia-org' }
    const workspace = { projects: [project(1, 'dia', [tab(1, 'mine'), owned])], visibleTab: null }

    expect(names(workspace, summaries())).toEqual([['dia', ['mine']]])
  })

  it('counts only the tabs no plugin owns', () => {
    const owned: Tab = { ...tab(2, 'Fix the anchor'), owner: 'dia-org' }
    const workspace = { projects: [project(1, 'dia', [tab(1, 'mine'), owned])], visibleTab: null }

    expect(buildOverview(workspace, summaries(), NO_FILTERS)[0]?.total).toBe(1)
  })

  it('leaves out projects a plugin owns', () => {
    const assistant = project(2, 'assistant', [tab(2, 'Assistant')])
    const workspace = {
      projects: [
        project(1, 'dia', [tab(1, 'mine')]),
        { ...assistant, project: { ...assistant.project, owner: 'dia-org' } }
      ],
      visibleTab: null
    }

    expect(names(workspace, summaries())).toEqual([['dia', ['mine']]])
  })

  it('gives each row its tab’s current permission mode', () => {
    const workspace: Workspace = {
      projects: [
        project(1, 'dia', [tab(1, 'fix-readme', false, 'bypassPermissions'), tab(2, 'notes')])
      ],
      visibleTab: null
    }

    const [group] = buildOverview(workspace, summaries(), NO_FILTERS)

    expect(group?.rows.map((row) => [row.name, row.permissionMode])).toEqual([
      ['fix-readme', 'bypassPermissions'],
      ['notes', 'default']
    ])
  })

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

  it('lists no group for a project without a thread', () => {
    const empty: Workspace = { projects: [project(3, 'notes', [])], visibleTab: null }

    expect(names(empty, summaries())).toEqual([])
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

  it('lists no group for a project whose only threads are archived or plugin-owned', () => {
    const owned: Tab = { ...tab(3, 'Fix the anchor'), owner: 'dia-org' }
    const closed: Workspace = {
      projects: [
        project(1, 'archived-only', [tab(1, 'old', true)]),
        project(2, 'owned-only', [owned]),
        project(4, 'live', [tab(4, 'now'), tab(5, 'old', true)])
      ],
      visibleTab: null
    }

    expect(names(closed, summaries())).toEqual([['live', ['now']]])
  })

  it('does not bring a project without an open thread back through the filters', () => {
    const closed: Workspace = {
      projects: [project(1, 'dia', [tab(1, 'heron', true)])],
      visibleTab: null
    }

    expect(
      [
        filters({ query: 'heron' }),
        filters({ query: 'dia', hideUnmatchedProjects: false }),
        filters({ statuses: ['StatusIdle'], hideUnmatchedProjects: false })
      ].map((applied) => names(closed, summaries(), applied))
    ).toEqual([[], [], []])
  })

  it('leaves archived threads out of the counts', () => {
    const mixed: Workspace = {
      projects: [project(1, 'dia', [tab(1, 'live'), tab(2, 'old', true)])],
      visibleTab: null
    }

    const group = buildOverview(mixed, summaries(), NO_FILTERS)[0]

    expect([group.shown, group.total]).toEqual([1, 1])
  })
})

describe('navigationOrder', () => {
  const workspace: Workspace = {
    projects: [project(1, 'dia', [tab(1, 'a'), tab(2, 'b')]), project(2, 'site', [tab(3, 'c')])],
    visibleTab: null
  }
  const groups = buildOverview(workspace, summaries(), NO_FILTERS)

  it('moves through each header followed by its rows', () => {
    expect(navigationOrder([], groups, new Set())).toEqual([
      HeaderTarget.make({ projectId: projectId(1) }),
      RowTarget.make({ paneId: paneId(1) }),
      RowTarget.make({ paneId: paneId(2) }),
      HeaderTarget.make({ projectId: projectId(2) }),
      RowTarget.make({ paneId: paneId(3) })
    ])
  })

  it('puts the Meta rows before the first header', () => {
    const creator: Tab = { ...tab(4, 'Creator'), owner: 'dia-creator' }
    const meta = buildMetaRows(
      { projects: [project(3, 'meta', [creator])], visibleTab: null },
      summaries(),
      new Set(['dia-creator'])
    )

    expect(navigationOrder(meta, groups, new Set()).slice(0, 2)).toEqual([
      RowTarget.make({ paneId: paneId(4) }),
      HeaderTarget.make({ projectId: projectId(1) })
    ])
  })

  it('skips the rows of a collapsed group', () => {
    expect(navigationOrder([], groups, new Set([projectId(1)]))).toEqual([
      HeaderTarget.make({ projectId: projectId(1) }),
      HeaderTarget.make({ projectId: projectId(2) }),
      RowTarget.make({ paneId: paneId(3) })
    ])
  })
})

describe('buildMetaRows', () => {
  const owned = (n: number, name: string, owner: string, archived = false): Tab => ({
    ...tab(n, name, archived),
    owner
  })

  it('lists the open tabs of the given owners from every project, marked owned', () => {
    const workspace: Workspace = {
      projects: [
        project(1, 'dia', [tab(1, 'mine'), owned(2, 'Creator', 'dia-creator')]),
        project(2, 'meta', [owned(3, 'Plugin work', 'dia-creator')])
      ],
      visibleTab: null
    }

    const rows = buildMetaRows(workspace, summaries(), new Set(['dia-creator']))

    expect(rows.map((row) => [row.name, row.owned])).toEqual([
      ['Creator', true],
      ['Plugin work', true]
    ])
  })

  it("leaves out archived tabs, unowned tabs and other owners' tabs", () => {
    const workspace: Workspace = {
      projects: [
        project(1, 'dia', [
          tab(1, 'mine'),
          owned(2, 'Assistant', 'dia-org'),
          owned(3, 'Old', 'dia-creator', true)
        ])
      ],
      visibleTab: null
    }

    expect(buildMetaRows(workspace, summaries(), new Set(['dia-creator']))).toEqual([])
  })

  it('lists the most urgent row first', () => {
    const workspace: Workspace = {
      projects: [
        project(1, 'meta', [owned(1, 'idle', 'dia-creator'), owned(2, 'failed', 'dia-creator')])
      ],
      visibleTab: null
    }

    const rows = buildMetaRows(
      workspace,
      summaries(summary(2, StatusFailed.make({ reason: 'crashed' }))),
      new Set(['dia-creator'])
    )

    expect(rows.map((row) => row.name)).toEqual(['failed', 'idle'])
  })

  it('marks the rows buildOverview lists as not owned', () => {
    const workspace: Workspace = {
      projects: [project(1, 'dia', [tab(1, 'mine')])],
      visibleTab: null
    }

    expect(buildOverview(workspace, summaries(), NO_FILTERS)[0]?.rows[0]?.owned).toBe(false)
  })
})
