import { cn } from '@renderer/lib/utils'
import type { AgentStatus } from '@shared/domain/agent-summary'
import { cva } from 'class-variance-authority'

const statusDot = cva('relative inline-flex size-2 rounded-full', {
  variants: {
    status: {
      StatusNeedsInput: 'bg-pulse-amber',
      StatusFailed: 'bg-pulse-red',
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
  StatusWorking: 'Working',
  StatusFinished: 'Finished',
  StatusIdle: 'Idle'
}

/** The word for an agent status, as the overview, tooltips and screen readers name it. */
export const statusLabel = (status: AgentStatus): string => STATUS_LABELS[status._tag]

interface StatusIndicatorProps {
  readonly status: AgentStatus
  readonly className?: string
}

/**
 * The status dot of one agent: amber and pulsing when it needs input, red and pulsing when it
 * failed, a slow neutral pulse while it works, steady green when it finished, a hollow ring when
 * idle. Decorative: put {@link statusLabel} in the accessible name of the row it sits in.
 */
export function StatusIndicator({ status, className }: StatusIndicatorProps): React.JSX.Element {
  const pulses = status._tag === 'StatusNeedsInput' || status._tag === 'StatusFailed'
  return (
    <span aria-hidden className={cn('relative flex size-2 shrink-0', className)}>
      {pulses && <span className={statusRing({ status: status._tag })} />}
      <span className={statusDot({ status: status._tag })} />
    </span>
  )
}
