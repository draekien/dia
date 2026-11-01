import {
  Button,
  cn,
  lastUserText,
  paneSendAtom,
  sendModeAtom,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@dia/renderer-plugin'
import { useAtomSet, useAtomValue } from '@effect/atom-react'
import type { CompactionFailure, ContextUsage } from '@shared/domain/context-usage'
import type { PaneId } from '@shared/domain/pane'
import {
  contextColor,
  contextPercent,
  contextTokensExact,
  contextTokensLine
} from './context-meter'
import { usePaneChat } from './use-pane-chat'

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

/** The Context card's id within the chat plugin; its rail key is `chat.context`. */
export const CONTEXT_CARD_ID = 'context'

/** The slash command that compacts the conversation. */
export const COMPACT_COMMAND = '/compact'

/**
 * The context usage readout: the share and token counts of `usage` with a meter coloured by
 * {@link contextColor}, a Compact conversation button that calls `onCompact`, and why the last
 * compaction did not run. Pass `usage` null before the first reading, `failure` for the last
 * compaction that did not run, `compacting` while a `/compact` turn runs, and `running` while
 * any other turn runs, which disables Compact.
 */
export function ContextUsageView({
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
    <div className="flex flex-col gap-3">
      {usage === null ? (
        <p className="text-muted-foreground">No usage yet</p>
      ) : (
        <Reading usage={usage} colour={colour} />
      )}
      <CompactButton running={running} compacting={compacting} onCompact={onCompact} />
      {failure !== null && (
        <p className={cn('text-xs', failed ? 'text-error' : 'text-muted-foreground')} role="status">
          {failure.message}
        </p>
      )}
    </div>
  )
}

/** The session rail's Context card body for `paneId`. Add it to the rail with `addRailCard`. */
export function ContextCard({ paneId }: { readonly paneId: PaneId }): React.JSX.Element {
  const chat = usePaneChat(paneId)
  const sendMessage = useAtomSet(paneSendAtom(paneId))
  const sendMode = useAtomValue(sendModeAtom)
  const compacting = chat.isLoading && lastUserText(chat)?.trim().split(/\s/)[0] === COMPACT_COMMAND
  return (
    <ContextUsageView
      usage={chat.contextUsage}
      failure={chat.compactionFailure}
      compacting={compacting}
      running={chat.isLoading}
      onCompact={() => sendMessage({ text: COMPACT_COMMAND, mode: sendMode })}
    />
  )
}
