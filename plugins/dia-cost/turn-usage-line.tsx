import type { TokenUsage } from '@dia/plugin'
import { Tooltip, TooltipContent, TooltipTrigger } from '@dia/renderer-plugin'
import { approximateTokens, exactTokens } from '@dia-plugin/dia-chat/token-count'
import { tokenTotal, usageOfMessages } from './usage'
import { type UsageAtoms, useRunUsage } from './usage-card'

const COUNTS = [
  ['In', 'inputTokens'],
  ['Out', 'outputTokens'],
  ['Cache read', 'cacheReadTokens'],
  ['Cache write', 'cacheWriteTokens']
] as const satisfies ReadonlyArray<readonly [string, keyof TokenUsage]>

const count = (tokens: number) => tokens.toLocaleString('en-US')

/**
 * The accessible text of a turn's usage `usage`, every count in full
 * (`'94,860 tokens: 4 in, 759 out, 92,484 cache read, 1,613 cache write'`).
 */
export const spokenUsage = (usage: TokenUsage): string =>
  `${exactTokens(tokenTotal(usage))}: ${COUNTS.map(
    ([label, key]) => `${count(usage[key])} ${label.toLowerCase()}`
  ).join(', ')}`

/**
 * The line at the end of a turn for usage `usage`: every token it used, rounded, with each count
 * in a tooltip on hover or focus. Renders nothing when `usage` has no tokens.
 */
export function TurnUsageView({ usage }: { readonly usage: TokenUsage }): React.JSX.Element | null {
  const total = tokenTotal(usage)
  if (total === 0) return null
  return (
    <div className="flex pt-1 pl-0.5 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip with the counts
              tabIndex={0}
              className="cursor-default rounded-sm tabular-nums outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span aria-hidden="true">{approximateTokens(total)} tokens</span>
              <span className="sr-only">{spokenUsage(usage)}</span>
            </span>
          }
        />
        <TooltipContent>
          <dl className="grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
            {COUNTS.map(([label, key]) => (
              <div key={key} className="contents">
                <dt>{label}</dt>
                <dd className="text-right">{count(usage[key])}</dd>
              </div>
            ))}
          </dl>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The line at the end of a turn in run `runId`'s transcript: {@link TurnUsageView} for the turns
 * `messageIds` started. Renders nothing while those turns have used no tokens, as for a turn still
 * running. It follows `usageAtoms(runId)`.
 */
export function TurnUsageLine({
  runId,
  messageIds,
  usageAtoms
}: {
  readonly runId: string
  readonly messageIds: ReadonlyArray<string>
  readonly usageAtoms: UsageAtoms
}): React.JSX.Element | null {
  const runUsage = useRunUsage(usageAtoms, runId)
  if (runUsage === undefined) return null
  return <TurnUsageView usage={usageOfMessages(runUsage, messageIds)} />
}
