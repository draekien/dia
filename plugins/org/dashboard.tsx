import { Button, openSettings } from '@dia/renderer-plugin'
import type { ReactNode } from 'react'
import type { OrgScreen } from './org-actions'

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
 * The Org Dashboard: the number of hired agents, how many job titles are enabled, and the overall
 * cap with a `Change` button that opens Settings › Org; then `Needs attention`, which while no
 * agent is hired holds one item whose `Hire…` opens the Hire dialog.
 */
export function Dashboard({ snapshot, openHire }: Pick<OrgScreen, 'snapshot' | 'openHire'>) {
  const enabled = snapshot.jobTitles.filter((jobTitle) => jobTitle.enabled).length
  const noHires = snapshot.hiredAgents.length === 0

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <dl className="grid grid-cols-3 divide-x border-y">
        <Stat label="Hired agents">
          <span className="text-lg font-medium tabular-nums">{snapshot.hiredAgents.length}</span>
        </Stat>
        <Stat label="Job titles">
          <span>
            <span className="text-lg font-medium tabular-nums">{enabled}</span>
            <span className="text-ink-muted">{` of ${snapshot.jobTitles.length} enabled`}</span>
          </span>
        </Stat>
        <Stat
          label="Running at once"
          action={
            <Button
              size="xs"
              variant="outline"
              onClick={() => openSettings({ plugin: 'org', id: 'org' })}
            >
              Change
            </Button>
          }
        >
          <span className="text-lg font-medium tabular-nums">{snapshot.settings.overallCap}</span>
        </Stat>
      </dl>
      <section className="flex flex-col gap-2" aria-labelledby="org-attention-heading">
        <h3 id="org-attention-heading" className="text-sm font-medium text-ink">
          Needs attention
        </h3>
        {noHires ? (
          <ul className="flex flex-col divide-y border-y">
            <li className="flex items-center justify-between gap-4 py-2.5">
              <span className="text-sm text-ink">
                No agents are hired. Hire one to start building the org.
              </span>
              <Button size="sm" variant="outline" onClick={() => openHire(null)}>
                Hire…
              </Button>
            </li>
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nothing needs attention.</p>
        )}
      </section>
    </div>
  )
}
