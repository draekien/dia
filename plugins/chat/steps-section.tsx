import {
  formatElapsed,
  Marker,
  MarkerContent,
  MarkerIcon,
  type StepsSection as StepsSectionBlock,
  sectionDurationMs
} from '@dia/renderer-plugin'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { StallActions, TurnActivityLine, type TurnActivityLineProps } from './turn-activity-line'

/**
 * The running turn's state, shown on the summary line of the section it is still adding to.
 * `label` names what the turn is doing; leave it out to name the section's latest step. The
 * callbacks back the stall actions.
 */
export interface LiveSteps extends TurnActivityLineProps {
  readonly onResend: () => void
  readonly onInterruptAndRetry: () => void
}

interface StepsSectionProps {
  readonly section: StepsSectionBlock
  readonly live?: LiveSteps
  readonly children: ReactNode
}

/** The focus ring every disclosure summary in the transcript shares. */
export const summaryFocus =
  'rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

const separator = <span aria-hidden> · </span>

function StepsSummary({ section }: { section: StepsSectionBlock }): React.JSX.Element {
  const steps = section.parts
  const failed = steps.filter((step) => step.type === 'tool-call' && step.isError === true).length
  const duration = sectionDurationMs(section)
  return (
    <MarkerContent className="tabular-nums">
      {steps.length} {steps.length === 1 ? 'step' : 'steps'}
      {failed > 0 && (
        <>
          {separator}
          <span className="text-foreground">{failed} failed</span>
        </>
      )}
      {duration !== undefined && (
        <>
          {separator}
          {formatElapsed(duration)}
        </>
      )}
    </MarkerContent>
  )
}

/**
 * Renders a collapsed run of an agent turn's steps: a summary line, and `children` (the
 * section's rendered parts) when the user expands it. The summary counts the steps, the failed
 * tool calls among them and the section's duration. Pass `live` while the turn is still adding
 * to this section; the summary then shows the turn's activity (`live.label` and elapsed time) in
 * place of the count, and the stall actions show under it. Collapsed until the user opens it.
 */
export function StepsSection({ section, live, children }: StepsSectionProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <details className="group/steps min-w-0">
        <summary
          className={`w-fit cursor-pointer list-none hover:*:text-foreground ${summaryFocus}`}
        >
          {live === undefined ? (
            <Marker className="pl-0.5 text-xs">
              <MarkerIcon className="flex items-center justify-center">
                <ChevronRight className="size-3 transition-transform group-open/steps:rotate-90 motion-reduce:transition-none" />
              </MarkerIcon>
              <StepsSummary section={section} />
            </Marker>
          ) : (
            <TurnActivityLine activity={live.activity} label={live.label} />
          )}
        </summary>
        <div className="mt-2.5 flex min-w-0 flex-col gap-2.5 pl-6">{children}</div>
      </details>
      {live?.activity.stalled === true && (
        <StallActions
          className="pl-6"
          onResend={live.onResend}
          onInterruptAndRetry={live.onInterruptAndRetry}
        />
      )}
    </div>
  )
}
