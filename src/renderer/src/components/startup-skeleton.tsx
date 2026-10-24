import { Skeleton } from './ui/skeleton'

/**
 * The placeholder for the pane area while dia starts: the layout is not available until the Host
 * has loaded the plugins an agent session needs. It shows the words `Starting dia` and the outline
 * of a conversation with its message box. Render it in place of the pane area until the layout
 * arrives.
 */
export function StartupSkeleton() {
  return (
    <div role="status" className="flex h-full min-h-0 flex-col gap-6 px-6 pt-4 pb-6">
      <p className="text-sm text-ink-muted">Starting dia</p>
      <div className="flex flex-1 flex-col gap-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <Skeleton className="h-20 w-full" />
    </div>
  )
}
