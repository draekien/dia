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
 * The tokens one turn, or a sum of turns, used: `inputTokens` of prompt input not read from the
 * prompt cache, `outputTokens` generated, `cacheReadTokens` of input read from the prompt cache and
 * `cacheWriteTokens` of input written to it.
 */
export const TokenUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadTokens: TokenCount,
  cacheWriteTokens: TokenCount
})
/** A {@link TokenUsage} value. */
export type TokenUsage = typeof TokenUsage.Type

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
