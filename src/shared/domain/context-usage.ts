import { Schema } from 'effect'

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * How full an agent's context window is, as the agent adapter last read it. `totalTokens` is the
 * number of tokens in the window and `maxTokens` its size. `autoCompactThreshold` is the token
 * count at which the agent compacts the conversation on its own; it is absent when automatic
 * compaction is off. Derive a percentage from `totalTokens / maxTokens`.
 */
export const ContextUsage = Schema.Struct({
  totalTokens: TokenCount,
  maxTokens: TokenCount,
  autoCompactThreshold: Schema.optional(TokenCount)
})
/** A {@link ContextUsage} value. */
export type ContextUsage = typeof ContextUsage.Type

/**
 * Why a requested compaction did not run, and the text to show the user. `nothingToCompact` means
 * the conversation was too short to compact, which is not an error; `failed` is any other failure.
 */
export const CompactionFailure = Schema.Struct({
  reason: Schema.Literals(['nothingToCompact', 'failed']),
  message: Schema.String
})
/** A {@link CompactionFailure} value. */
export type CompactionFailure = typeof CompactionFailure.Type
