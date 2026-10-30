import type { AgentSummary } from '@shared/domain/agent-summary'
import { Schema } from 'effect'

const PaneIds = Schema.Array(Schema.String)

/** Some agent is parked because Claude Code is not signed in; `paneIds` are the agents Retry resumes. */
export const SignedOutBanner = Schema.TaggedStruct('SignedOutBanner', { paneIds: PaneIds })
export type SignedOutBanner = typeof SignedOutBanner.Type

/** Some agent waits for the user after its usage limit reset; `paneIds` are the agents Resume all resumes. */
export const LimitResetBanner = Schema.TaggedStruct('LimitResetBanner', { paneIds: PaneIds })
export type LimitResetBanner = typeof LimitResetBanner.Type

/** Some agent hit a usage limit with no known reset time; `paneIds` are the agents Resume all resumes. */
export const LimitUnknownBanner = Schema.TaggedStruct('LimitUnknownBanner', { paneIds: PaneIds })
export type LimitUnknownBanner = typeof LimitUnknownBanner.Type

/**
 * `count` agents wait for their usage limit to reset, after which the user resumes them; the
 * earliest reset is at `resetsAt` (epoch ms).
 */
export const LimitWaitingBanner = Schema.TaggedStruct('LimitWaitingBanner', {
  resetsAt: Schema.Int,
  count: Schema.Int
})
export type LimitWaitingBanner = typeof LimitWaitingBanner.Type

/** Every parked agent, `count` of them, resumes on its own; the first at `resumesAt` (epoch ms). */
export const LimitResumingBanner = Schema.TaggedStruct('LimitResumingBanner', {
  resumesAt: Schema.Int,
  count: Schema.Int
})
export type LimitResumingBanner = typeof LimitResumingBanner.Type

/** What the account banner shows. Branch on `_tag`; build it with {@link accountBannerOf}. */
export const AccountBanner = Schema.Union([
  SignedOutBanner,
  LimitResetBanner,
  LimitUnknownBanner,
  LimitWaitingBanner,
  LimitResumingBanner
])
export type AccountBanner = typeof AccountBanner.Type

/**
 * Whether the agent of `summary` is parked and only the user can resume it: it is not signed in,
 * or its usage limit has reset or has no known reset time. The banner and the transcript offer
 * Resume for such an agent.
 */
export const awaitsUser = (summary: AgentSummary): boolean =>
  summary.parked !== undefined && summary.status._tag === 'StatusNeedsInput'

const parkedUntil = (
  summaries: ReadonlyArray<AgentSummary>,
  resumedBy: 'dia' | 'user'
): ReadonlyArray<number> =>
  summaries.flatMap((summary) =>
    summary.status._tag === 'StatusParked' && summary.status.resumedBy === resumedBy
      ? [summary.status.until]
      : []
  )

/**
 * The account banner for the agents in `summaries`, or null when no agent is parked. An agent that
 * is not signed in comes first, then agents whose limit reset, then agents with no known reset
 * time, then agents waiting for a reset, then agents dia resumes on its own.
 */
export const accountBannerOf = (summaries: Iterable<AgentSummary>): AccountBanner | null => {
  const all = [...summaries]
  const forUser = all.filter(awaitsUser)
  const paneIdsWhere = (keep: (summary: AgentSummary) => boolean) =>
    forUser.filter(keep).map((summary) => summary.paneId)
  const resetsOf = (summary: AgentSummary) =>
    summary.parked?._tag === 'UsageLimit' ? summary.parked.resetsAt : undefined

  const signedOut = paneIdsWhere((summary) => summary.parked?._tag === 'SignedOut')
  if (signedOut.length > 0) return SignedOutBanner.make({ paneIds: signedOut })

  const reset = paneIdsWhere((summary) => typeof resetsOf(summary) === 'number')
  if (reset.length > 0) return LimitResetBanner.make({ paneIds: reset })

  const unknown = paneIdsWhere((summary) => resetsOf(summary) === null)
  if (unknown.length > 0) return LimitUnknownBanner.make({ paneIds: unknown })

  const waiting = parkedUntil(all, 'user')
  if (waiting.length > 0) {
    return LimitWaitingBanner.make({ resetsAt: Math.min(...waiting), count: waiting.length })
  }

  const resuming = parkedUntil(all, 'dia')
  return resuming.length === 0
    ? null
    : LimitResumingBanner.make({ resumesAt: Math.min(...resuming), count: resuming.length })
}
