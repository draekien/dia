import type { PluginServices } from '@dia/plugin'
import { followHost } from '@dia/renderer-plugin'
import { exactTokens } from '@dia-plugin/dia-chat/token-count'
import { useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { FollowRunUsage, type RunUsage } from './calls'
import { tokenTotal } from './usage'

/** Makes the atoms that follow each run's usage for the `dia-cost` renderer entry `ctx`. */
export const makeUsageAtoms = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.family((runId: string) => Atom.make(followHost(ctx, FollowRunUsage, { runId })))

/** The atom family {@link makeUsageAtoms} makes; {@link UsageCard} and the turn line read its atoms. */
export type UsageAtoms = ReturnType<typeof makeUsageAtoms>

/** Run `runId`'s latest usage from `usageAtoms`, or `undefined` before the first value arrives. */
export const useRunUsage = (usageAtoms: UsageAtoms, runId: string): RunUsage | undefined => {
  const result = useAtomValue(usageAtoms(runId))
  return AsyncResult.isSuccess(result) ? Option.getOrUndefined(result.value) : undefined
}

/**
 * The session rail's Usage card body for run `runId`: one line with the exact number of tokens
 * the run's main agent loop has used across all its turns. It follows `usageAtoms(runId)`.
 */
export function UsageCard({
  runId,
  usageAtoms
}: {
  readonly runId: string
  readonly usageAtoms: UsageAtoms
}): React.JSX.Element {
  const usage = useRunUsage(usageAtoms, runId)
  const total = usage === undefined ? 0 : tokenTotal(usage.total)
  if (total === 0) {
    return <p className="text-muted-foreground">No token usage yet</p>
  }
  return (
    <p className="tabular-nums">
      {exactTokens(total)}
      <span className="text-muted-foreground"> · main agent</span>
    </p>
  )
}
