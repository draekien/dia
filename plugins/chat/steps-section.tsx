import {
  formatElapsed,
  Marker,
  MarkerContent,
  MarkerIcon,
  type StepsSection as StepsSectionBlock,
  sectionDurationMs,
  sectionSteps,
  type TurnActivity
} from '@dia/renderer-plugin'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { TurnActivityLine } from './turn-activity-line'

/**
 * The running turn's state, shown on the summary line of the section it is still adding to.
 * `label` names what the turn is doing; leave it out to name the section's latest step.
 */
export interface LiveSteps {
  readonly activity: TurnActivity
  readonly label?: ReactNode
  readonly onResend: () => void
  readonly onInterruptAndRetry: () => void
}

interface StepsSectionProps {
  readonly section: StepsSectionBlock
  readonly live?: LiveSteps
  readonly children: ReactNode
}

const stepsSummary = (section: StepsSectionBlock): string => {
  const count = sectionSteps(section).length
  const duration = sectionDurationMs(section)
  const steps = `${count} ${count === 1 ? 'step' : 'steps'}`
  return duration === undefined ? steps : `${steps} · ${formatElapsed(duration)}`
}

/**
 * Renders a collapsed run of an agent turn's steps: a summary line, and `children` (the
 * section's rendered parts) when the user expands it. Pass `live` while the turn is still adding
 * to this section; the summary then shows the turn's activity (`live.label`, elapsed time and the
 * stall actions) in place of the step count and duration. Collapsed until the user opens it.
 */
export function StepsSection({ section, live, children }: StepsSectionProps): React.JSX.Element {
  return (
    <details className="group/steps min-w-0">
      <summary className="w-fit cursor-pointer list-none">
        {live === undefined ? (
          <Marker className="pl-0.5 text-muted-foreground text-xs hover:text-foreground">
            <MarkerIcon className="flex items-center justify-center">
              <ChevronRight className="size-3 transition-transform group-open/steps:rotate-90 motion-reduce:transition-none" />
            </MarkerIcon>
            <MarkerContent className="tabular-nums">{stepsSummary(section)}</MarkerContent>
          </Marker>
        ) : (
          <TurnActivityLine
            activity={live.activity}
            label={live.label}
            onResend={live.onResend}
            onInterruptAndRetry={live.onInterruptAndRetry}
          />
        )}
      </summary>
      <div className="mt-2.5 flex min-w-0 flex-col gap-2.5 pl-3">{children}</div>
    </details>
  )
}
