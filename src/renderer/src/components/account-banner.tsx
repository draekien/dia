import { useAtomValue } from '@effect/atom-react'
import { useNow } from '@renderer/hooks/use-now'
import { accountBannerOf, type AccountBanner as Banner } from '@renderer/lib/account-banner'
import { resumeParkedAgent } from '@renderer/lib/actions'
import { formatResetTime } from '@renderer/lib/format-when'
import { agentSummariesAtom } from '@renderer/lib/workspace-atoms'
import { Duration } from 'effect'
import { Button } from './ui/button'

const resumeAll = (paneIds: ReadonlyArray<string>): void => {
  for (const paneId of paneIds) resumeParkedAgent(paneId)
}

function BannerContent({ banner, nowMs }: { banner: Banner; nowMs: number }) {
  switch (banner._tag) {
    case 'SignedOutBanner':
      return (
        <>
          <span>
            Claude Code is signed out. Run <code className="font-mono">claude</code> in a terminal
            and sign in, then
          </span>
          <Button variant="outline" size="xs" onClick={() => resumeAll(banner.paneIds)}>
            Retry
          </Button>
        </>
      )
    case 'LimitResetBanner':
    case 'LimitUnknownBanner':
      return (
        <>
          <span>
            {banner._tag === 'LimitResetBanner' ? 'Usage limit reset' : 'Usage limit reached'}
            <span aria-hidden> · </span>
          </span>
          <Button variant="outline" size="xs" onClick={() => resumeAll(banner.paneIds)}>
            Resume all
          </Button>
        </>
      )
    case 'LimitWaitingBanner':
      return <span>Usage limit reached · resets {formatResetTime(banner.resetsAt, nowMs)}</span>
    case 'LimitResumingBanner':
      return <span>Usage limit reached · resumes {formatResetTime(banner.resumesAt, nowMs)}</span>
  }
}

/**
 * The app-wide strip that tells the user an agent is parked because the account refused its turn:
 * Claude Code is signed out, or a usage limit was reached. It offers Retry or Resume all when only
 * the user can resume the agents, and renders nothing while no agent is parked. Place it above the
 * content area.
 */
export function AccountBanner(): React.JSX.Element | null {
  const summaries = useAtomValue(agentSummariesAtom)
  const nowMs = useNow(Duration.minutes(1))
  const banner = accountBannerOf(summaries.values(), nowMs)
  if (banner === null) return null
  return (
    <div
      role="status"
      className="flex min-h-9 shrink-0 items-center gap-2 border-b px-4 py-1.5 text-sm text-ink-muted"
    >
      <BannerContent banner={banner} nowMs={nowMs} />
    </div>
  )
}
