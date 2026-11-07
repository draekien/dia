import { Schema } from 'effect'
import type { OrgSnapshot } from './calls'
import { HireId, JobTitleId, ObjectiveId } from './domain'

/** The Org page's Dashboard sub-page. */
export const DashboardView = Schema.TaggedStruct('DashboardView', {})

/**
 * The Org page's Objectives sub-page, with `objectiveId` selected; null selects the first. An id
 * the work view does not hold yet shows a placeholder until it arrives.
 */
export const ObjectivesView = Schema.TaggedStruct('ObjectivesView', {
  objectiveId: Schema.NullOr(ObjectiveId)
})

/** The Org page's Org chart sub-page. */
export const OrgChartView = Schema.TaggedStruct('OrgChartView', {})

/** The Org page's Job titles sub-page, with `jobTitleId` selected; null selects the first. */
export const JobTitlesView = Schema.TaggedStruct('JobTitlesView', {
  jobTitleId: Schema.NullOr(JobTitleId)
})

/** The Org page's Hired agents sub-page, with `hireId` selected; null selects the first. */
export const HiredAgentsView = Schema.TaggedStruct('HiredAgentsView', {
  hireId: Schema.NullOr(HireId)
})

/** Which Org sub-page is shown, and on the list pages which entry is selected; null selects the first entry. */
export const OrgView = Schema.Union([
  DashboardView,
  ObjectivesView,
  OrgChartView,
  JobTitlesView,
  HiredAgentsView
])
export type OrgView = typeof OrgView.Type

/**
 * The view to draw for `view` against `snapshot`: `view` itself, except that a selected job title
 * or hired agent `snapshot` no longer holds becomes null.
 */
export const showView = (snapshot: OrgSnapshot, view: OrgView): OrgView => {
  switch (view._tag) {
    case 'JobTitlesView':
      return view.jobTitleId === null ||
        snapshot.jobTitles.some((jobTitle) => jobTitle.id === view.jobTitleId)
        ? view
        : JobTitlesView.make({ jobTitleId: null })
    case 'HiredAgentsView':
      return view.hireId === null || snapshot.hiredAgents.some((agent) => agent.id === view.hireId)
        ? view
        : HiredAgentsView.make({ hireId: null })
    default:
      return view
  }
}
