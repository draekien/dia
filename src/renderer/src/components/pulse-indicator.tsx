import { cn } from '@renderer/lib/utils'
import type { AttentionState } from '@shared/domain/attention'
import { cva } from 'class-variance-authority'

const pulseDot = cva('relative inline-flex size-2.5 rounded-full', {
  variants: {
    state: {
      Idle: 'bg-ink-muted animate-pulse-slow motion-reduce:animate-none',
      AwaitingPermission: 'bg-pulse-amber',
      Errored: 'bg-pulse-red',
      Crashed: 'bg-pulse-red',
      Completed: 'bg-pulse-green'
    }
  }
})

const pulseRing = cva(
  'absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden',
  {
    variants: {
      state: {
        AwaitingPermission: 'bg-pulse-amber',
        Errored: 'bg-pulse-red',
        Completed: 'bg-pulse-green'
      }
    }
  }
)

interface PulseIndicatorProps {
  readonly attention: AttentionState
  readonly className?: string
}

export function PulseIndicator({ attention, className }: PulseIndicatorProps): React.JSX.Element {
  const state = attention._tag

  // Crashed is terminal, so it shows a steady red dot with no ping ring -- the pane is dead, not
  // asking for attention. Idle's own gentle pulse lives on the dot, so it gets no ring either.
  const hasRing = state !== 'Idle' && state !== 'Crashed'

  return (
    <span className={cn('relative flex size-2.5 shrink-0', className)}>
      {hasRing && <span className={pulseRing({ state })} />}
      <span className={pulseDot({ state })} />
    </span>
  )
}
