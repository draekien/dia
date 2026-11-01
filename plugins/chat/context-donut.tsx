import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@dia/renderer-plugin'
import type { CompactionFailure, ContextUsage } from '@shared/domain/context-usage'
import {
  contextColor,
  contextFraction,
  contextPercent,
  contextTokensExact,
  contextTokensLine
} from './context-meter'

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function Ring({
  fraction,
  colour,
  working
}: {
  fraction: number
  colour: string
  working: boolean
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        style={{ stroke: colour }}
        className={cn(
          'transition-[stroke-dashoffset,stroke] duration-300 motion-reduce:transition-none',
          working && 'animate-pulse motion-reduce:animate-none'
        )}
      />
    </svg>
  )
}

function CompactButton({
  running,
  compacting,
  onCompact
}: {
  running: boolean
  compacting: boolean
  onCompact: () => void
}): React.JSX.Element {
  const blocked = running && !compacting
  const button = (
    <Button
      size="sm"
      variant="outline"
      className={cn('w-full', blocked && 'opacity-50')}
      disabled={compacting}
      aria-busy={compacting}
      aria-disabled={blocked || undefined}
      onClick={blocked ? undefined : onCompact}
    >
      Compact conversation
    </Button>
  )
  if (!blocked) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>Available when this turn ends</TooltipContent>
    </Tooltip>
  )
}

function Reading({ usage, colour }: { usage: ContextUsage; colour: string }): React.JSX.Element {
  const percent = contextPercent(usage)
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{percent}% of context used</p>
        <p className="text-muted-foreground text-xs" title={contextTokensExact(usage)}>
          {contextTokensLine(usage)}
        </p>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a native meter cannot take the computed fill colour */}
      <div
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% of context used, ${contextTokensLine(usage)}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
      >
        <div
          className="h-full rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent}%`, backgroundColor: colour }}
        />
      </div>
    </>
  )
}

/**
 * The composer header's context indicator: a 16px ring filled to how much of the context window
 * `usage` uses, coloured by {@link contextColor}. It opens a popover with the numbers and a
 * Compact conversation button that calls `onCompact`. Pass `usage` null before the first reading,
 * `failure` for the last compaction that did not run, `compacting` while a `/compact` turn runs,
 * and `running` while any other turn runs, which disables Compact.
 */
export function ContextDonut({
  usage,
  failure,
  compacting,
  running,
  onCompact
}: {
  usage: ContextUsage | null
  failure: CompactionFailure | null
  compacting: boolean
  running: boolean
  onCompact: () => void
}): React.JSX.Element {
  const failed = failure?.reason === 'failed'
  const colour = usage === null || compacting ? 'var(--ink-muted)' : contextColor(usage, failed)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={usage === null ? 'Context usage' : `Context ${contextPercent(usage)}% used`}
        >
          <Ring
            fraction={usage === null ? 0 : contextFraction(usage)}
            colour={colour}
            working={compacting}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-3 text-sm">
        {usage === null ? (
          <p className="text-muted-foreground">Context usage appears after the first turn</p>
        ) : (
          <Reading usage={usage} colour={colour} />
        )}
        <CompactButton running={running} compacting={compacting} onCompact={onCompact} />
        {failure !== null && (
          <p
            className={cn('text-xs', failed ? 'text-error' : 'text-muted-foreground')}
            role="status"
          >
            {failure.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
