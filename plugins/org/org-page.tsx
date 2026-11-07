import type { PluginServices } from '@dia/plugin'
import { Button, cn, Skeleton } from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Cause } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import { AgentsPage } from './agents-page'
import type { OrgSnapshot } from './calls'
import { Dashboard } from './dashboard'
import type { JobTitleId } from './domain'
import { HireDialog } from './hire-dialog'
import { JobTitlesPage } from './job-titles-page'
import { type OrgAtom, type OrgScreen, useOrgCall } from './org-actions'
import { OrgChart } from './org-chart'
import {
  DashboardView,
  HiredAgentsView,
  JobTitlesView,
  OrgChartView,
  type OrgView,
  showView
} from './org-view'

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

const LABELS: Record<OrgView['_tag'], string> = {
  DashboardView: 'Dashboard',
  OrgChartView: 'Org chart',
  JobTitlesView: 'Job titles',
  HiredAgentsView: 'Hired agents'
}

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

function SubPage({ view, screen }: { readonly view: OrgView; readonly screen: OrgScreen }) {
  switch (view._tag) {
    case 'DashboardView':
      return <Dashboard snapshot={screen.snapshot} openHire={screen.openHire} />
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
  call
}: {
  readonly snapshot: OrgSnapshot
  readonly view: OrgView
  readonly setView: (view: OrgView) => void
  readonly call: OrgScreen['call']
}) {
  const [hiring, setHiring] = useState<{ readonly jobTitleId: JobTitleId | null } | undefined>(
    undefined
  )
  const shown = showView(snapshot, view)
  const screen: OrgScreen = {
    snapshot,
    call,
    show: setView,
    openHire: (jobTitleId) => setHiring({ jobTitleId })
  }

  return (
    <>
      <SubPage view={shown} screen={screen} />
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
    </>
  )
}

/**
 * The Org page in the content area: a sub-navigation of Dashboard, Org chart, Job titles and
 * Hired agents beside the current sub-page under its own heading. It reads `orgAtom` while shown
 * and opens on Dashboard each time; `ctx` is the `org` renderer entry the calls go through.
 */
export function OrgPage({
  ctx,
  orgAtom
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly orgAtom: OrgAtom
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
            onFailure: ({ cause }) => (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-error">{Cause.prettyErrors(cause)[0]?.message}</p>
                <Button size="sm" variant="outline" onClick={retry}>
                  Try again
                </Button>
              </div>
            ),
            onSuccess: ({ value }) => (
              <Loaded snapshot={value} view={view} setView={setView} call={call} />
            )
          })}
        </div>
      </div>
    </div>
  )
}
