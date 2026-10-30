import { useAtomValue } from '@effect/atom-react'
import { useNow } from '@renderer/hooks/use-now'
import { accountBannerOf, type AccountBanner as Banner } from '@renderer/lib/account-banner'
import { resumeParkedAgent } from '@renderer/lib/actions'
import { formatResetTime } from '@renderer/lib/format-when'
import { cn } from '@renderer/lib/utils'
import { agentSummariesAtom } from '@renderer/lib/workspace-atoms'
import { Duration } from 'effect'
import { useRef } from 'react'
import { Button } from './ui/button'

const agents = (count: number): string => (count === 1 ? '1 agent' : `${count} agents`)

const Dot = () => <span aria-hidden> · </span>

function BannerContent({
  banner,
  nowMs,
  onResume
}: {
  banner: Banner
  nowMs: number
  onResume: (paneIds: ReadonlyArray<string>) => void
}) {
  switch (banner._tag) {
    case 'SignedOutBanner':
      return (
        <>
          <span>
            Claude Code is not signed in. Run <code className="font-mono">claude auth login</code>,
            then
          </span>
          <Button variant="ghost" size="xs" onClick={() => onResume(banner.paneIds)}>
            Retry
          </Button>
        </>
      )
    case 'LimitResetBanner':
    case 'LimitUnknownBanner':
      return (
        <>
          <span>
            {banner._tag === 'LimitResetBanner'
              ? 'Usage limit has reset'
              : 'Usage limit reached, reset time unknown'}
            <Dot />
            {agents(banner.paneIds.length)} waiting
          </span>
          <Button variant="ghost" size="xs" onClick={() => onResume(banner.paneIds)}>
            Resume all
          </Button>
        </>
      )
    case 'LimitWaitingBanner':
      return (
        <span>
          Usage limit reached
          <Dot />
          you can resume {agents(banner.count)} at {formatResetTime(banner.resetsAt, nowMs)}
        </span>
      )
    case 'LimitResumingBanner':
      return (
        <span>
          Usage limit reached
          <Dot />
          dia resumes {agents(banner.count)} at {formatResetTime(banner.resumesAt, nowMs)}
        </span>
      )
  }
}

/**
 * The app-wide strip that tells the user an agent is parked because the account refused its turn:
 * Claude Code is not signed in, or a usage limit was reached. It offers Retry or Resume all when
 * only the user can resume the agents, and is empty while no agent is parked. Place it above the
 * content area.
 */
export function AccountBanner(): React.JSX.Element {
  const summaries = useAtomValue(agentSummariesAtom)
  const nowMs = useNow(Duration.minutes(1))
  const regionRef = useRef<HTMLDivElement>(null)
  const banner = accountBannerOf(summaries.values())
  const resume = (paneIds: ReadonlyArray<string>) => {
    regionRef.current?.focus()
    for (const paneId of paneIds) resumeParkedAgent(paneId)
  }
  return (
    <div
      ref={regionRef}
      role="status"
      tabIndex={-1}
      className={cn(
        'outline-none',
        banner !== null &&
          'flex min-h-9 shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs text-ink-muted'
      )}
    >
      {banner !== null && <BannerContent banner={banner} nowMs={nowMs} onResume={resume} />}
    </div>
  )
}
