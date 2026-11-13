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

const hasTokens = (usage: TokenUsage) => Object.values(usage).some((tokens) => tokens > 0)

function Counts({ usage }: { readonly usage: TokenUsage }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
      {COUNTS.map(([label, key]) => (
        <div key={key} className="flex min-w-0 justify-between gap-1.5">
          <dt className="truncate text-muted-foreground">{label}</dt>
          <dd className="shrink-0 tabular-nums">{usage[key].toLocaleString('en-US')}</dd>
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
 * total, then per turn that used tokens, newest first, numbered from 1 at each message sent to the
 * run. It follows `usageAtoms(runId)`.
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
  const turns = usage?.turns.filter((turn) => hasTokens(turn.usage)) ?? []
  if (usage === undefined || turns.length === 0) {
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
        {[...turns].reverse().map((turn) => (
          <Turn key={turn.turn} turn={turn} />
        ))}
      </ul>
    </div>
  )
}
