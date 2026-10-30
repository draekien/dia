import { Button, Marker, MarkerIcon, type TurnActivity } from '@dia/renderer-plugin'
import type { MouseEvent, ReactNode } from 'react'

interface TurnActivityLineProps {
  readonly activity: TurnActivity
  readonly label?: ReactNode
  readonly onResend: () => void
  readonly onInterruptAndRetry: () => void
}

/**
 * Renders the mid-turn activity line shown at the tail of a pane's transcript
 * while a turn is in flight. Shows a neutral pulsing dot, the current
 * {@link TurnActivity} label, and the elapsed-seconds counter once past the
 * short delay. When the turn has stalled, reveals manual `Resend` and
 * `Interrupt & retry` actions so the user is never stuck on a silent session —
 * `onResend` submits the last prompt again in the default send mode,
 * `onInterruptAndRetry` sends it as a steer, which aborts the in-flight turn first. Deliberately uses a
 * neutral dot, not a coloured pulse: attention colour is reserved for the pane
 * pulse indicator (the app's one loud signal). `label` replaces the activity's own label. The
 * actions do not toggle a `<details>` whose summary holds the line.
 */
export function TurnActivityLine({
  activity,
  label = activity.label,
  onResend,
  onInterruptAndRetry
}: TurnActivityLineProps): React.JSX.Element {
  const act = (action: () => void) => (event: MouseEvent) => {
    event.preventDefault()
    action()
  }
  return (
    <Marker className="pl-0.5 text-xs">
      <MarkerIcon className="flex items-center justify-center">
        <span className="size-1.5 animate-pulse-slow rounded-full bg-muted-foreground motion-reduce:animate-none" />
      </MarkerIcon>
      <span aria-live="polite" className="flex min-w-0 items-center gap-2">
        {label}
      </span>
      {activity.elapsedLabel !== undefined && (
        <span aria-hidden className="tabular-nums text-muted-foreground/70">
          {activity.elapsedLabel}
        </span>
      )}
      {activity.stalled && (
        <span className="ml-1 flex items-center gap-1">
          <Button type="button" variant="outline" size="xs" onClick={act(onInterruptAndRetry)}>
            Interrupt & retry
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={act(onResend)}
          >
            Resend
          </Button>
        </span>
      )}
    </Marker>
  )
}
