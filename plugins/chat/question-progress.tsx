import { cn } from '@dia/renderer-plugin'

/** How far the user has got with one question in a clarifying-question card. */
export type QuestionProgressStatus = 'unanswered' | 'answered' | 'skipped'

/**
 * Segmented progress bar for a clarifying-question card: one segment per question and the
 * position as `2 of 3`. `statuses` holds one entry per question in order and `current` is the
 * zero-based index of the question on screen. Renders nothing for fewer than two questions.
 */
export function QuestionProgress({
  statuses,
  current
}: {
  statuses: ReadonlyArray<QuestionProgressStatus>
  current: number
}) {
  const total = statuses.length
  if (total < 2) return null
  const label = `Question ${current + 1} of ${total}`
  return (
    <div className="flex items-center gap-3">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current + 1}
        aria-valuetext={label}
        className="flex flex-1 gap-1.5"
      >
        {statuses.map((status, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
            key={index}
            data-status={status}
            data-current={index === current ? '' : undefined}
            className={cn(
              'h-1.5 flex-1 rounded-full border transition-colors duration-150 motion-reduce:transition-none',
              status === 'answered' && 'border-primary bg-primary',
              status === 'skipped' && 'border-border bg-muted',
              status === 'unanswered' && 'border-transparent bg-muted',
              index === current && 'border-primary'
            )}
          />
        ))}
      </div>
      <span aria-hidden="true" className="text-muted-foreground text-xs tabular-nums">
        {current + 1} of {total}
      </span>
    </div>
  )
}
