import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button
} from '@dia/renderer-plugin'
import type { Tab } from '@shared/domain/project'
import { RETIREMENT_COPY, type Retirement, retireInBackground } from './background-retirement'

interface RetireAgentDialogProps {
  readonly tab: Tab
  readonly retirement: Retirement
  readonly onClose: () => void
  /** The element focus returns to when the dialog closes; `null` or a detached element falls back to the dialog's default. */
  readonly returnFocus?: HTMLElement | null
}

/**
 * Confirms archiving or deleting the thread of `tab`, saying what is removed (the running thread,
 * its worktree with any uncommitted changes) and what stays (the branch and the transcripts), then
 * starts the change in the background and closes. A failure is reported by a toast.
 */
export function RetireThreadDialog({
  tab,
  retirement,
  onClose,
  returnFocus
}: RetireAgentDialogProps) {
  const copy = RETIREMENT_COPY[retirement]
  const worktree = tab.config.worktree

  const confirm = () => {
    retireInBackground({ paneId: tab.config.paneId, name: tab.name }, retirement)
    onClose()
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent
        className="sm:max-w-md"
        finalFocus={() => (returnFocus?.isConnected === true ? returnFocus : null)}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{`${copy.verb} ${tab.name}?`}</AlertDialogTitle>
          <AlertDialogDescription
            render={
              <div className="flex flex-col gap-2">
                {!tab.archived && (
                  <p>
                    {worktree === undefined
                      ? 'dia stops this thread.'
                      : 'dia stops this thread and deletes its worktree, with any uncommitted changes in it:'}
                  </p>
                )}
                {!tab.archived && worktree !== undefined && (
                  <p className="font-mono text-xs break-all text-ink">{worktree.path}</p>
                )}
                <p>
                  {retirement === 'archive'
                    ? 'The thread moves to the Archived list, where its transcript stays readable.'
                    : 'dia forgets the thread and removes it from the sidebar.'}{' '}
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

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant={retirement === 'delete' ? 'destructive' : 'default'} onClick={confirm}>
            {copy.verb}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
