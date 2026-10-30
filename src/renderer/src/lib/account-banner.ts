import type { AgentSummary } from '@shared/domain/agent-summary'
import { Schema } from 'effect'

const PaneIds = Schema.Array(Schema.String)

/** Some agent is parked because Claude Code is signed out; `paneIds` are the agents Retry resumes. */
export const SignedOutBanner = Schema.TaggedStruct('SignedOutBanner', { paneIds: PaneIds })
export type SignedOutBanner = typeof SignedOutBanner.Type

/** Some agent waits for the user after its usage limit reset; `paneIds` are the agents Resume all resumes. */
export const LimitResetBanner = Schema.TaggedStruct('LimitResetBanner', { paneIds: PaneIds })
export type LimitResetBanner = typeof LimitResetBanner.Type

/** Some agent hit a usage limit with no known reset time; `paneIds` are the agents Resume all resumes. */
export const LimitUnknownBanner = Schema.TaggedStruct('LimitUnknownBanner', { paneIds: PaneIds })
export type LimitUnknownBanner = typeof LimitUnknownBanner.Type

/** Some agent waits for the user once its usage limit resets at `resetsAt` (epoch ms, the earliest). */
export const LimitWaitingBanner = Schema.TaggedStruct('LimitWaitingBanner', {
  resetsAt: Schema.Int
})
export type LimitWaitingBanner = typeof LimitWaitingBanner.Type

/** Every parked agent resumes on its own; the first at `resumesAt` (epoch ms). */
export const LimitResumingBanner = Schema.TaggedStruct('LimitResumingBanner', {
  resumesAt: Schema.Int
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

const waitsForUser = (summary: AgentSummary): boolean =>
  summary.parked !== undefined && summary.status._tag === 'StatusNeedsInput'

/**
 * Whether the agent of `summary` is parked and only the user can resume it at `nowMs` (epoch ms):
 * it is signed out, or its usage limit has reset or has no known reset time. The banner and the
 * transcript offer Resume for such an agent.
 */
export const awaitsUser = (summary: AgentSummary, nowMs: number): boolean => {
  if (!waitsForUser(summary) || summary.parked === undefined) return false
  return summary.parked._tag === 'SignedOut' || (summary.parked.resetsAt ?? nowMs) <= nowMs
}

const earliest = (times: ReadonlyArray<number>): number | null =>
  times.length === 0 ? null : Math.min(...times)

/**
 * The account banner for the agents in `summaries` at `nowMs` (epoch ms), or null when no agent is
 * parked. A signed-out agent comes first, then agents whose limit reset, then agents with no known
 * reset time, then agents waiting for a reset, then agents dia resumes on its own.
 */
export const accountBannerOf = (
  summaries: Iterable<AgentSummary>,
  nowMs: number
): AccountBanner | null => {
  const parked = [...summaries].filter((summary) => summary.parked !== undefined)
  const forUser = parked.filter(waitsForUser)
  const paneIdsWhere = (keep: (summary: AgentSummary) => boolean) =>
    forUser.filter(keep).map((summary) => summary.paneId)

  const signedOut = paneIdsWhere((summary) => summary.parked?._tag === 'SignedOut')
  if (signedOut.length > 0) return SignedOutBanner.make({ paneIds: signedOut })

  const resetsOf = (summary: AgentSummary) =>
    summary.parked?._tag === 'UsageLimit' ? summary.parked.resetsAt : undefined
  const reset = paneIdsWhere((summary) => {
    const resetsAt = resetsOf(summary)
    return resetsAt !== undefined && resetsAt !== null && resetsAt <= nowMs
  })
  if (reset.length > 0) return LimitResetBanner.make({ paneIds: reset })

  const unknown = paneIdsWhere((summary) => resetsOf(summary) === null)
  if (unknown.length > 0) return LimitUnknownBanner.make({ paneIds: unknown })

  const waiting = earliest(
    forUser.flatMap((summary) => {
      const resetsAt = resetsOf(summary)
      return resetsAt === undefined || resetsAt === null ? [] : [resetsAt]
    })
  )
  if (waiting !== null) return LimitWaitingBanner.make({ resetsAt: waiting })

  const resuming = earliest(
    parked.flatMap((summary) =>
      summary.status._tag === 'StatusParked' ? [summary.status.resumesAt] : []
    )
  )
  return resuming === null ? null : LimitResumingBanner.make({ resumesAt: resuming })
}
