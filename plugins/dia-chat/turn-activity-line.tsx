import { Button, cn, Marker, MarkerIcon, type TurnActivity } from '@dia/renderer-plugin'
import type { ReactNode } from 'react'

/** What {@link TurnActivityLine} shows. `label` replaces the activity's own label. */
export interface TurnActivityLineProps {
  readonly activity: TurnActivity
  readonly label?: ReactNode
}

interface StallActionsProps {
  readonly onResend: () => void
  readonly onInterruptAndRetry: () => void
  readonly className?: string
}

/**
 * The actions offered when a running turn has stalled, so the user is never stuck on a silent
 * session: `Interrupt & retry` calls `onInterruptAndRetry`, `Resend` calls `onResend`. Render it
 * on its own row under the activity line, only while the turn is stalled.
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
 * Renders the mid-turn activity line shown while a turn is in flight: a neutral pulsing dot, the
 * current {@link TurnActivity} label, and the elapsed time once past the short delay. The dot
 * stops pulsing once the turn has stalled. It holds no buttons, so it can sit inside a
 * `<summary>`; render {@link StallActions} beside it when the turn has stalled. Deliberately uses
 * a neutral dot, not a coloured pulse: attention colour is reserved for the pane pulse indicator
 * (the app's one loud signal).
 */
export function TurnActivityLine({
  activity,
  label = activity.label
}: TurnActivityLineProps): React.JSX.Element {
  return (
    <Marker className="pl-0.5 text-xs">
      <MarkerIcon className="flex items-center justify-center">
        <span
          className={cn(
            'size-1.5 rounded-full bg-muted-foreground',
            !activity.stalled && 'animate-pulse-slow motion-reduce:animate-none'
          )}
        />
      </MarkerIcon>
      <span aria-live="polite" className="flex min-w-0 items-center gap-2">
        {label}
      </span>
      {activity.elapsedLabel !== undefined && (
        <span aria-hidden className="tabular-nums">
          {activity.elapsedLabel}
        </span>
      )}
    </Marker>
  )
}
