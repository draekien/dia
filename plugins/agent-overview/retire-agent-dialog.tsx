import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  actions,
  Button
} from '@dia/renderer-plugin'
import type { Tab } from '@shared/domain/project'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'

/** Which change {@link RetireAgentDialog} confirms: archiving the agent, or deleting it. */
export type Retirement = 'archive' | 'delete'

type Phase =
  | { readonly _tag: 'Confirm' }
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'Failed'; readonly reason: string }

const COPY = {
  archive: { verb: 'Archive', running: 'Archiving…', failed: 'Not archived' },
  delete: { verb: 'Delete', running: 'Deleting…', failed: 'Not deleted' }
} as const

interface RetireAgentDialogProps {
  readonly tab: Tab
  readonly retirement: Retirement
  readonly onClose: () => void
}

/**
 * Confirms archiving or deleting the agent of `tab`, then runs it. It says what is removed (the
 * running agent, its worktree with any uncommitted changes, and for delete dia's record of the
 * agent) and what stays (the branch and the transcripts). When the worktree cannot be removed it
 * shows the reason and offers "Try again"; the agent is left as it was. Closes once the change is
 * made.
 */
export function RetireAgentDialog({ tab, retirement, onClose }: RetireAgentDialogProps) {
  const [phase, setPhase] = useState<Phase>({ _tag: 'Confirm' })
  const copy = COPY[retirement]
  const worktree = tab.config.worktree
  const busy = phase._tag === 'Running'

  const run = () => {
    setPhase({ _tag: 'Running' })
    const change = retirement === 'archive' ? actions.archiveTab : actions.deleteTab
    change(tab.config.paneId).then(
      (reason) => (reason === null ? onClose() : setPhase({ _tag: 'Failed', reason })),
      () =>
        setPhase({
          _tag: 'Failed',
          reason: "The connection to dia's background process was lost."
        })
    )
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{`${copy.verb} ${tab.name}?`}</AlertDialogTitle>
          <AlertDialogDescription
            render={
              <div className="flex flex-col gap-2">
                {!tab.archived && (
                  <p>
                    {worktree === undefined
                      ? 'dia stops this agent.'
                      : 'dia stops this agent and deletes its worktree, with any uncommitted changes in it:'}
                  </p>
                )}
                {worktree !== undefined && (
                  <p className="font-mono text-xs break-all text-ink">{worktree.path}</p>
                )}
                <p>
                  {retirement === 'archive'
                    ? 'The agent moves to the Archived list, where its transcript stays readable.'
                    : 'dia forgets the agent and removes it from the sidebar.'}{' '}
                  {worktree === undefined ? (
                    'Its Claude Code transcripts stay on disk.'
                  ) : (
                    <>
                      Its branch <span className="font-mono text-xs">{worktree.branch}</span> and
                      its Claude Code transcripts stay on disk.
                    </>
                  )}
                </p>
              </div>
            }
          />
        </AlertDialogHeader>

        {phase._tag === 'Failed' && (
          <p role="alert" className="text-sm text-error">
            {copy.failed}: {phase.reason}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant={retirement === 'delete' ? 'destructive' : 'default'}
            disabled={busy}
            onClick={run}
          >
            {busy && (
              <Loader2Icon
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            {busy ? copy.running : phase._tag === 'Failed' ? 'Try again' : copy.verb}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
