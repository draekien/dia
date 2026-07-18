import type { PanePlanReviewRequested } from '@shared/ipc/contract'
import { Markdown } from './markdown'
import { Button } from './ui/button'

/**
 * Inline card that presents a pane's proposed plan (raised when its agent, in
 * `plan` mode, calls `ExitPlanMode`) for the user to approve or reject. Pass the
 * pane's {@link PanePlanReviewRequested} as `request`; `onResolve` is called once
 * with `true` to approve — letting the agent proceed and restoring the pane's
 * pre-plan mode — or `false` to keep the pane planning. The card is non-blocking,
 * so the user may instead redirect the pane via the composer, superseding it.
 */
export function PlanReviewCard({
  request,
  onResolve
}: {
  request: PanePlanReviewRequested
  onResolve: (approved: boolean) => void
}) {
  return (
    <section className="mt-2 flex flex-col gap-4 rounded-md border bg-muted/40 p-3">
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-foreground">Plan ready for review</p>
        <p className="text-xs text-muted-foreground">
          Approve to let Claude proceed and return to its previous mode, or keep planning to refine
          it further.
        </p>
      </div>

      <div className="max-h-80 overflow-y-auto rounded-md border bg-background p-3">
        <Markdown content={request.plan} />
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => onResolve(false)}>
          Keep planning
        </Button>
        <Button size="sm" onClick={() => onResolve(true)}>
          Approve
        </Button>
      </div>
    </section>
  )
}
