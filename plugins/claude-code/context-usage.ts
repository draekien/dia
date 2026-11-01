import type { Query, SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { ContextUsage } from '@shared/domain/context-usage'
import { Data, Effect } from 'effect'

/** The Agent SDK refused or failed a context usage read; `cause` is what it threw. */
export class ContextUsageReadError extends Data.TaggedError('ContextUsageReadError')<{
  readonly cause: unknown
}> {}

/**
 * Reads the context window usage of a live query. `detail: 'summary'` answers from the last
 * response and local estimates in a few milliseconds; `'full'` also counts each category with the
 * token-count API. Safe to call while a turn runs.
 */
export const readContextUsage = (
  query: Pick<Query, 'getContextUsage'>,
  detail: 'summary' | 'full'
): Effect.Effect<SDKControlGetContextUsageResponse, ContextUsageReadError> =>
  Effect.tryPromise({
    try: () => query.getContextUsage({ detail }),
    catch: (cause) => new ContextUsageReadError({ cause })
  })

/**
 * The part of an Agent SDK context usage reading that dia reports to the renderer. The
 * auto-compact threshold is kept only while automatic compaction is on.
 */
export const toContextUsage = (response: SDKControlGetContextUsageResponse): ContextUsage => ({
  totalTokens: response.totalTokens,
  maxTokens: response.maxTokens,
  ...(response.isAutoCompactEnabled && response.autoCompactThreshold !== undefined
    ? { autoCompactThreshold: response.autoCompactThreshold }
    : {})
})
