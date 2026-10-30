import { cn } from '@renderer/lib/utils'
import type { AgentStatus } from '@shared/domain/agent-summary'
import { cva } from 'class-variance-authority'

const statusDot = cva('relative inline-flex size-2 rounded-full', {
  variants: {
    status: {
      StatusNeedsInput: 'bg-pulse-amber',
      StatusFailed: 'bg-pulse-red',
      StatusParked: 'bg-ink-muted/40',
      StatusWorking: 'bg-ink-muted animate-pulse-slow motion-reduce:animate-none',
      StatusFinished: 'bg-pulse-green',
      StatusIdle: 'border border-ink-muted bg-transparent'
    }
  }
})

const statusRing = cva(
  'absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden',
  {
    variants: {
      status: {
        StatusNeedsInput: 'bg-pulse-amber',
        StatusFailed: 'bg-pulse-red'
      }
    }
  }
)

const STATUS_LABELS: Record<AgentStatus['_tag'], string> = {
  StatusNeedsInput: 'Needs input',
  StatusFailed: 'Failed',
  StatusParked: 'Parked',
  StatusWorking: 'Working',
  StatusFinished: 'Finished',
  StatusIdle: 'Idle'
}

/** The word for an agent status, as the overview, tooltips and screen readers name it. */
export const statusLabel = (status: AgentStatus): string => STATUS_LABELS[status._tag]

interface StatusIndicatorProps {
  readonly status: AgentStatus
  readonly className?: string
  readonly still?: boolean
}

/**
 * The status dot of one agent: amber and pulsing when it needs input, red and pulsing when it
 * failed, a steady dimmed dot while it is parked until a usage limit resets, a slow neutral pulse
 * while it works, steady green when it finished, a hollow ring when
 * idle. Pass `still` for a legend or sample that must not animate, because it stands for a
 * status rather than reporting one. Decorative: put {@link statusLabel} in the accessible name
 * of the row it sits in.
 */
export function StatusIndicator({
  status,
  className,
  still = false
}: StatusIndicatorProps): React.JSX.Element {
  const pulses = !still && (status._tag === 'StatusNeedsInput' || status._tag === 'StatusFailed')
  return (
    <span aria-hidden className={cn('relative flex size-2 shrink-0', className)}>
      {pulses && <span className={statusRing({ status: status._tag })} />}
      <span className={cn(statusDot({ status: status._tag }), still && 'animate-none')} />
    </span>
  )
}
