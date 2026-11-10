import type { PluginServices } from '@dia/plugin'
import { cn, Skeleton } from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import { AgentsPage } from './agents-page'
import type { OrgSnapshot } from './calls'
import { Dashboard } from './dashboard'
import type { JobTitleId } from './domain'
import { HireDialog } from './hire-dialog'
import { JobTitlesPage } from './job-titles-page'
import { type LiveAtom, type OrgAtom, type OrgScreen, useOrgCall } from './org-actions'
import { OrgChart } from './org-chart'
import { LoadFailure } from './org-fields'
import {
  DashboardView,
  HiredAgentsView,
  JobTitlesView,
  OrgChartView,
  type OrgView,
  showView
} from './org-view'
import { StaffDialog } from './staff-dialog'

const NAV = [
  {
    group: 'Overview',
    pages: [
      { tag: 'DashboardView', label: 'Dashboard', view: () => DashboardView.make({}) },
      { tag: 'OrgChartView', label: 'Org chart', view: () => OrgChartView.make({}) }
    ]
  },
  {
    group: 'Manage',
    pages: [
      {
        tag: 'JobTitlesView',
        label: 'Job titles',
        view: () => JobTitlesView.make({ jobTitleId: null })
      },
      {
        tag: 'HiredAgentsView',
        label: 'Hired agents',
        view: () => HiredAgentsView.make({ hireId: null })
      }
    ]
  }
] as const

const LABELS: Record<OrgView['_tag'], string> = Object.fromEntries(
  NAV.flatMap((section) => section.pages.map((page) => [page.tag, page.label]))
) as Record<OrgView['_tag'], string>

function SubNav({
  view,
  onShow
}: {
  readonly view: OrgView
  readonly onShow: (next: OrgView) => void
}) {
  return (
    <nav aria-label="Org pages" className="flex w-44 shrink-0 flex-col gap-4 border-r p-2">
      {NAV.map((section) => (
        <div key={section.group} className="flex flex-col gap-px">
          <span className="px-2 pt-1 pb-1.5 text-xs text-ink-muted">{section.group}</span>
          {section.pages.map((page) => (
            <button
              key={page.tag}
              type="button"
              aria-current={view._tag === page.tag ? 'page' : undefined}
              onClick={() => onShow(page.view())}
              className={cn(
                'rounded-md px-2 py-1.5 text-left text-sm text-ink outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/50',
                view._tag === page.tag && 'bg-primary/10 font-medium hover:bg-primary/10'
              )}
            >
              {page.label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}

function SubPage({
  view,
  screen,
  liveAtom
}: {
  readonly view: OrgView
  readonly screen: OrgScreen
  readonly liveAtom: LiveAtom
}) {
  switch (view._tag) {
    case 'DashboardView':
      return (
        <Dashboard snapshot={screen.snapshot} openStaff={screen.openStaff} liveAtom={liveAtom} />
      )
    case 'OrgChartView':
      return <OrgChart snapshot={screen.snapshot} show={screen.show} openHire={screen.openHire} />
    case 'JobTitlesView':
      return <JobTitlesPage jobTitleId={view.jobTitleId} {...screen} />
    case 'HiredAgentsView':
      return <AgentsPage hireId={view.hireId} {...screen} />
  }
}

function Loaded({
  snapshot,
  view,
  setView,
  call,
  liveAtom
}: {
  readonly snapshot: OrgSnapshot
  readonly view: OrgView
  readonly setView: (view: OrgView) => void
  readonly call: OrgScreen['call']
  readonly liveAtom: LiveAtom
}) {
  const [hiring, setHiring] = useState<{ readonly jobTitleId: JobTitleId | null } | undefined>(
    undefined
  )
  const [staffing, setStaffing] = useState(false)
  const shown = showView(snapshot, view)
  const screen: OrgScreen = {
    snapshot,
    call,
    show: setView,
    openHire: (jobTitleId) => setHiring({ jobTitleId }),
    openStaff: () => setStaffing(true)
  }

  return (
    <>
      <SubPage view={shown} screen={screen} liveAtom={liveAtom} />
      {hiring === undefined ? null : (
        <HireDialog
          snapshot={snapshot}
          jobTitleId={hiring.jobTitleId}
          call={call}
          onHired={(agent) => {
            setHiring(undefined)
            setView(HiredAgentsView.make({ hireId: agent.id }))
          }}
          onClose={() => setHiring(undefined)}
        />
      )}
      {staffing ? (
        <StaffDialog
          snapshot={snapshot}
          call={call}
          onStaffed={() => setStaffing(false)}
          onClose={() => setStaffing(false)}
        />
      ) : null}
    </>
  )
}

/**
 * The Org page in the content area: a sub-navigation of Dashboard, Org chart, Job titles and Hired
 * agents beside the current sub-page under its own heading. It reads `orgAtom` while shown, and
 * `liveAtom` while Dashboard is shown. It opens on Dashboard; `ctx` is the `org` renderer entry the
 * calls go through.
 */
export function OrgPage({
  ctx,
  orgAtom,
  liveAtom
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly orgAtom: OrgAtom
  readonly liveAtom: LiveAtom
}) {
  const result = useAtomValue(orgAtom)
  const retry = useAtomRefresh(orgAtom)
  const call = useOrgCall(ctx, orgAtom)
  const [view, setView] = useState<OrgView>(() => DashboardView.make({}))

  return (
    <div className="flex h-full min-h-0">
      <SubNav view={view} onShow={setView} />
      <div className="@container min-w-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-5 px-6 py-5">
          <h2 className="text-base font-semibold text-ink">{LABELS[view._tag]}</h2>
          {AsyncResult.match(result, {
            onInitial: () => (
              <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton className="h-14 w-full max-w-3xl" />
                <Skeleton className="h-4 w-64" />
              </div>
            ),
            onFailure: ({ cause }) => <LoadFailure cause={cause} retry={retry} />,
            onSuccess: ({ value }) => (
              <Loaded
                snapshot={value}
                view={view}
                setView={setView}
                call={call}
                liveAtom={liveAtom}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
