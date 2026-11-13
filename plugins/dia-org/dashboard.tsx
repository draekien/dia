import { Button, openSettings, useWorkspace } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import type { ReactNode } from 'react'
import { OnboardingStrip, onboardingStage, TeamWorkBox } from './onboarding'
import type { LiveAtom, OrgScreen } from './org-actions'

function Stat({
  label,
  children,
  action
}: {
  readonly label: string
  readonly children: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-3 first:pl-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="flex items-baseline gap-3 text-sm text-ink">
        {children}
        {action}
      </dd>
    </div>
  )
}

/**
 * The Org Dashboard. Until the team has work it opens with the onboarding strip (Add a project,
 * Staff the org, Get the team working), whose `Staff the org…` calls `openStaff`, and at Get the
 * team working the box that sends a request to the Executive assistant. Then the number of hired
 * agents, how many job titles are enabled, and the overall cap with a `Change` button that opens
 * Settings › Org; then `Needs attention`, which holds one alert naming what the Executive
 * assistant definition holds that resolves to nothing while `liveAtom` reports any.
 */
export function Dashboard({
  snapshot,
  openStaff,
  call,
  liveAtom
}: Pick<OrgScreen, 'snapshot' | 'openStaff' | 'call'> & { readonly liveAtom: LiveAtom }) {
  const enabled = snapshot.jobTitles.filter((jobTitle) => jobTitle.enabled).length
  const hires = snapshot.hiredAgents.length
  const workspace = useWorkspace()
  const result = useAtomValue(liveAtom)
  const live = AsyncResult.isSuccess(result) ? result.value : Option.none()
  const stage =
    workspace === undefined || (hires > 0 && Option.isNone(live))
      ? null
      : onboardingStage(
          workspace.projects.length,
          hires,
          Option.exists(live, (view) => view.teamHasWork)
        )

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {stage === null ? null : (
        <div className="flex flex-col gap-4">
          <OnboardingStrip stage={stage} openStaff={openStaff} />
          {stage === 'get-working' ? (
            <TeamWorkBox
              assistantEnabled={Option.exists(live, (view) => view.assistantEnabled)}
              assistantRunId={Option.match(live, {
                onNone: () => null,
                onSome: (view) => view.assistantRunId
              })}
              call={call}
            />
          ) : null}
        </div>
      )}
      <dl className="grid grid-cols-3 divide-x border-y">
        <Stat label="Hired agents">
          <span className="text-base font-medium tabular-nums">{hires}</span>
        </Stat>
        <Stat label="Job titles">
          <span>
            <span className="text-base font-medium tabular-nums">{enabled}</span>
            <span className="text-ink-muted">{` of ${snapshot.jobTitles.length} enabled`}</span>
          </span>
        </Stat>
        <Stat
          label="Running at once"
          action={
            <Button
              size="xs"
              variant="outline"
              onClick={() => openSettings({ plugin: 'dia-org', id: 'org' })}
            >
              Change
            </Button>
          }
        >
          <span className="text-base font-medium tabular-nums">{snapshot.settings.overallCap}</span>
        </Stat>
      </dl>
    </div>
  )
}
