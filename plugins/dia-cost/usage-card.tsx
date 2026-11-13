import type { PluginServices, TokenUsage } from '@dia/plugin'
import { followHost } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { FollowRunUsage, type TurnUsage } from './calls'

/** Makes the atoms that follow each run's usage for the `dia-cost` renderer entry `ctx`. */
export const makeUsageAtoms = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.family((runId: string) => Atom.make(followHost(ctx, FollowRunUsage, { runId })))

/** The atom family {@link makeUsageAtoms} makes; {@link UsageCard} reads one of its atoms. */
export type UsageAtoms = ReturnType<typeof makeUsageAtoms>

const COUNTS = [
  ['In', 'inputTokens'],
  ['Out', 'outputTokens'],
  ['Cache read', 'cacheReadTokens'],
  ['Cache write', 'cacheWriteTokens']
] as const satisfies ReadonlyArray<readonly [string, keyof TokenUsage]>

function Counts({ usage }: { readonly usage: TokenUsage }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-4 gap-x-2 text-xs">
      {COUNTS.map(([label, key]) => (
        <div key={key} className="flex min-w-0 flex-col">
          <dt className="truncate text-muted-foreground">{label}</dt>
          <dd className="truncate tabular-nums">{usage[key].toLocaleString('en-US')}</dd>
        </div>
      ))}
    </dl>
  )
}

function Turn({ turn }: { readonly turn: TurnUsage }): React.JSX.Element {
  return (
    <li className="flex flex-col gap-1">
      <p className="flex min-w-0 gap-1.5 text-xs">
        <span className="shrink-0 text-muted-foreground">Turn {turn.turn}</span>
        <span className="min-w-0 truncate" title={turn.prompt}>
          {turn.prompt}
        </span>
      </p>
      <Counts usage={turn.usage} />
    </li>
  )
}

/**
 * The session rail's Usage card body for run `runId`: the tokens of the run's main agent loop in
 * total, then per turn, newest first. It follows `usageAtoms(runId)`.
 */
export function UsageCard({
  runId,
  usageAtoms
}: {
  readonly runId: string
  readonly usageAtoms: UsageAtoms
}): React.JSX.Element {
  const result = useAtomValue(usageAtoms(runId))
  const usage = AsyncResult.isSuccess(result) ? Option.getOrUndefined(result.value) : undefined
  if (usage === undefined || usage.turns.length === 0) {
    return <p className="text-muted-foreground">No token usage yet</p>
  }
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-1">
        <p className="text-xs">
          Total <span className="text-muted-foreground">· main agent tokens</span>
        </p>
        <Counts usage={usage.total} />
      </section>
      <ul className="flex flex-col gap-3">
        {[...usage.turns].reverse().map((turn) => (
          <Turn key={turn.turn} turn={turn} />
        ))}
      </ul>
    </div>
  )
}
