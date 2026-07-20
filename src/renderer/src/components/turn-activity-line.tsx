import type { TurnActivity } from '../lib/turn-activity'
import { Button } from './ui/button'

interface TurnActivityLineProps {
  readonly activity: TurnActivity
  readonly onResend: () => void
  readonly onInterruptAndRetry: () => void
}

/**
 * Renders the mid-turn activity line shown at the tail of a pane's transcript
 * while a turn is in flight. Shows a neutral pulsing dot, the current
 * {@link TurnActivity} label, and the elapsed-seconds counter once past the
 * short delay. When the turn has stalled, reveals manual `Resend` and
 * `Interrupt & retry` actions so the user is never stuck on a silent session —
 * `onResend` submits the last prompt again (superseding any pending request),
 * `onInterruptAndRetry` aborts the in-flight turn first. Deliberately uses a
 * neutral dot, not a coloured pulse: attention colour is reserved for the pane
 * pulse indicator (the app's one loud signal).
 */
export function TurnActivityLine({
  activity,
  onResend,
  onInterruptAndRetry
}: TurnActivityLineProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 text-muted-foreground text-xs">
      <span className="size-1.5 shrink-0 animate-pulse-slow rounded-full bg-muted-foreground motion-reduce:animate-none" />
      <span aria-live="polite">{activity.label}…</span>
      {activity.elapsedLabel !== undefined && (
        <span aria-hidden className="tabular-nums text-muted-foreground/70">
          {activity.elapsedLabel}
        </span>
      )}
      {activity.stalled && (
        <span className="ml-1 flex items-center gap-1">
          <Button type="button" variant="outline" size="xs" onClick={onInterruptAndRetry}>
            Interrupt & retry
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={onResend}
          >
            Resend
          </Button>
        </span>
      )}
    </div>
  )
}
