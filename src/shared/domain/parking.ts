import { Duration, Schema } from 'effect'

/** The account's usage limit refused the turn. `resetsAt` is epoch milliseconds, or null when the SDK sent none. */
export const UsageLimit = Schema.TaggedStruct('UsageLimit', {
  resetsAt: Schema.NullOr(Schema.Int)
})
export type UsageLimit = typeof UsageLimit.Type

/** Claude Code is not signed in, so the account refused the turn. */
export const SignedOut = Schema.TaggedStruct('SignedOut', {})
export type SignedOut = typeof SignedOut.Type

/** Why the account refused a turn. Branch on `_tag`; pass it to {@link resumesAtFor}. */
export const ParkCause = Schema.Union([UsageLimit, SignedOut])
export type ParkCause = typeof ParkCause.Type

/** What dia does when a usage limit resets: send `continue` itself, or wait for the user. */
export const UsageLimitResume = Schema.Literals(['automatic', 'manual'])
export type UsageLimitResume = typeof UsageLimitResume.Type

/** The message dia sends to a parked agent to resume its refused turn. */
export const RESUME_TEXT = 'continue'

/** The resume mode when the user has not chosen one. */
export const DEFAULT_USAGE_LIMIT_RESUME: UsageLimitResume = 'automatic'

/** The longest wait dia schedules; a later reset waits for the user. */
export const MAX_AUTOMATIC_WAIT = Duration.days(7)

/** How long after the reset dia sends `continue`, so a timer that fires early does not meet the limit again. */
export const RESUME_GRACE = Duration.seconds(5)

/**
 * When dia will send `continue` by itself, in epoch milliseconds, or null to wait for the user:
 * `resetsAt` plus {@link RESUME_GRACE} under `automatic` when `resetsAt` lies after `nowMs` and the
 * result is no more than {@link MAX_AUTOMATIC_WAIT} ahead, else null.
 */
export const resumesAtFor = (
  cause: ParkCause,
  mode: UsageLimitResume,
  nowMs: number
): number | null => {
  if (cause._tag !== 'UsageLimit' || mode !== 'automatic' || cause.resetsAt === null) return null
  if (cause.resetsAt <= nowMs) return null
  const resumesAt = cause.resetsAt + Duration.toMillis(RESUME_GRACE)
  return resumesAt - nowMs <= Duration.toMillis(MAX_AUTOMATIC_WAIT) ? resumesAt : null
}
