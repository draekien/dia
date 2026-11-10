import { describe, expect, it } from 'vitest'
import type { OrgSnapshot } from './calls'
import { HiredAgent, HireId, JobTitle, JobTitleId, JobTitleName, OverallCap } from './domain'
import { DashboardView, HiredAgentsView, JobTitlesView, OrgChartView, showView } from './org-view'

const JOB_TITLE_ID = JobTitleId.make('00000000-0000-4000-8000-000000000100')
const GONE_JOB_TITLE_ID = JobTitleId.make('00000000-0000-4000-8000-000000000199')
const HIRE_ID = HireId.make('00000000-0000-4000-8000-000000000001')
const GONE_HIRE_ID = HireId.make('00000000-0000-4000-8000-000000000099')

const snapshot: OrgSnapshot = {
  jobTitles: [
    JobTitle.make({
      id: JOB_TITLE_ID,
      name: JobTitleName.make('Reviewer'),
      builtIn: null,
      enabled: true,
      jobDescription: '',
      skills: [],
      permissions: { allow: [], ask: [], deny: [] },
      mcpServers: [],
      bypassOptIn: false,
      model: null,
      thinkingLevel: 'medium'
    })
  ],
  hiredAgents: [
    HiredAgent.make({
      id: HIRE_ID,
      jobTitleId: JOB_TITLE_ID,
      name: null,
      bypassOverride: null,
      reportsTo: null,
      hiredAt: 1
    })
  ],
  settings: { overallCap: OverallCap.make(4) },
  bypassAvailable: true,
  worktreeProjects: []
}

describe('showView', () => {
  it('keeps a selected job title the snapshot still holds', () => {
    const view = JobTitlesView.make({ jobTitleId: JOB_TITLE_ID })

    expect(showView(snapshot, view)).toEqual(view)
  })

  it('clears a selected job title the snapshot no longer holds', () => {
    expect(showView(snapshot, JobTitlesView.make({ jobTitleId: GONE_JOB_TITLE_ID }))).toEqual(
      JobTitlesView.make({ jobTitleId: null })
    )
  })

  it('keeps a selected agent the snapshot still holds', () => {
    const view = HiredAgentsView.make({ hireId: HIRE_ID })

    expect(showView(snapshot, view)).toEqual(view)
  })

  it('clears a selected agent the snapshot no longer holds', () => {
    expect(showView(snapshot, HiredAgentsView.make({ hireId: GONE_HIRE_ID }))).toEqual(
      HiredAgentsView.make({ hireId: null })
    )
  })

  it.each([
    ['Dashboard', DashboardView.make({})],
    ['Org chart', OrgChartView.make({})]
  ])('returns the %s view unchanged', (_name, view) => {
    expect(showView(snapshot, view)).toBe(view)
  })
})
