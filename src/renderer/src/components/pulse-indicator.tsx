import type { AttentionState } from '../dia'

const COLOR_BY_TAG: Record<Exclude<AttentionState['_tag'], 'Idle'>, string> = {
  AwaitingPermission: 'bg-pulse-amber',
  Errored: 'bg-pulse-red',
  Completed: 'bg-pulse-green'
}

interface PulseIndicatorProps {
  readonly attention: AttentionState
  readonly className?: string
}

export function PulseIndicator({
  attention,
  className = ''
}: PulseIndicatorProps): React.JSX.Element | null {
  if (attention._tag === 'Idle') return null

  const color = COLOR_BY_TAG[attention._tag]

  return (
    <span className={`relative flex size-2.5 ${className}`}>
      <span
        className={`absolute inline-flex size-full animate-ping rounded-full ${color} opacity-75 motion-reduce:hidden`}
      />
      <span className={`relative inline-flex size-2.5 rounded-full ${color}`} />
    </span>
  )
}
