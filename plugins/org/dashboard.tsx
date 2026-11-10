import {
  Button,
  List,
  ListRow,
  ListRowAction,
  ListRowLink,
  ListRowName,
  ListRowSubject,
  openSettings
} from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import type { ReactNode } from 'react'
import { describeMissing } from './domain'
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
 * The Org Dashboard: the number of hired agents, how many job titles are enabled, and the overall
 * cap with a `Change` button that opens Settings › Org; then `Needs attention`, which holds one
 * item whose `Hire…` opens the Hire dialog while no agent is hired, and one alert naming what the
 * Executive assistant definition holds that resolves to nothing while `liveAtom` reports any.
 */
export function Dashboard({
  snapshot,
  openHire,
  liveAtom
}: Pick<OrgScreen, 'snapshot' | 'openHire'> & { readonly liveAtom: LiveAtom }) {
  const enabled = snapshot.jobTitles.filter((jobTitle) => jobTitle.enabled).length
  const noHires = snapshot.hiredAgents.length === 0
  const live = useAtomValue(liveAtom)
  const assistantMissing = AsyncResult.isSuccess(live)
    ? Option.match(live.value, { onNone: () => [], onSome: (view) => view.assistantMissing })
    : []

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <dl className="grid grid-cols-3 divide-x border-y">
        <Stat label="Hired agents">
          <span className="text-base font-medium tabular-nums">{snapshot.hiredAgents.length}</span>
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
              onClick={() => openSettings({ plugin: 'org', id: 'org' })}
            >
              Change
            </Button>
          }
        >
          <span className="text-base font-medium tabular-nums">{snapshot.settings.overallCap}</span>
        </Stat>
      </dl>
      <section className="flex flex-col gap-2" aria-labelledby="org-attention-heading">
        <h3 id="org-attention-heading" className="text-sm font-medium text-ink">
          Needs attention
        </h3>
        {noHires || assistantMissing.length > 0 ? (
          <List aria-labelledby="org-attention-heading">
            {assistantMissing.length > 0 ? (
              <ListRow value="assistant-missing" role="alert">
                <ListRowLink render={<div />}>
                  <ListRowSubject>
                    <ListRowName className="whitespace-normal font-normal text-error">
                      {`Executive assistant cannot start: missing ${describeMissing(assistantMissing)}`}
                    </ListRowName>
                  </ListRowSubject>
                </ListRowLink>
              </ListRow>
            ) : null}
            {noHires ? (
              <ListRow value="no-hires">
                <ListRowLink render={<div />}>
                  <ListRowSubject>
                    <ListRowName className="whitespace-normal font-normal">
                      No agents are hired. Hire one to start building the org.
                    </ListRowName>
                  </ListRowSubject>
                </ListRowLink>
                <ListRowAction>
                  <Button size="sm" variant="outline" onClick={() => openHire(null)}>
                    Hire…
                  </Button>
                </ListRowAction>
              </ListRow>
            ) : null}
          </List>
        ) : (
          <p className="text-sm text-ink-muted">Nothing needs attention.</p>
        )}
      </section>
    </div>
  )
}
