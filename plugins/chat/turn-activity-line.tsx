import { Button, cn, Marker, MarkerIcon, type TurnActivity } from '@dia/renderer-plugin'
import type { ReactNode } from 'react'

/** What {@link TurnActivityLine} shows, and what its stall actions call. */
export interface TurnActivityLineProps {
  readonly activity: TurnActivity
  readonly label?: ReactNode
  readonly onResend: () => void
  readonly onInterruptAndRetry: () => void
}

interface StallActionsProps {
  readonly onResend: () => void
  readonly onInterruptAndRetry: () => void
  readonly className?: string
}

/**
 * The actions offered when a running turn has stalled: `Interrupt & retry` calls
 * `onInterruptAndRetry`, `Resend` calls `onResend`. Render it only while the turn is stalled.
 */
export function StallActions({
  onResend,
  onInterruptAndRetry,
  className
}: StallActionsProps): React.JSX.Element {
  return (
    <span className={cn('flex items-center gap-1', className)}>
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
  )
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
 * pulse indicator (the app's one loud signal). `label` replaces the activity's own label. Pass
 * `actions={false}` where the caller shows {@link StallActions} itself, such as inside a
 * `<summary>`, which must not hold buttons.
 */
export function TurnActivityLine({
  activity,
  label = activity.label,
  onResend,
  onInterruptAndRetry,
  actions = true
}: TurnActivityLineProps & { readonly actions?: boolean }): React.JSX.Element {
  return (
    <Marker className="pl-0.5 text-xs">
      <MarkerIcon className="flex items-center justify-center">
        <span className="size-1.5 animate-pulse-slow rounded-full bg-muted-foreground motion-reduce:animate-none" />
      </MarkerIcon>
      <span aria-live="polite" className="flex min-w-0 items-center gap-2">
        {label}
      </span>
      {activity.elapsedLabel !== undefined && (
        <span aria-hidden className="tabular-nums">
          {activity.elapsedLabel}
        </span>
      )}
      {actions && activity.stalled && (
        <StallActions
          className="ml-1"
          onResend={onResend}
          onInterruptAndRetry={onInterruptAndRetry}
        />
      )}
    </Marker>
  )
}
