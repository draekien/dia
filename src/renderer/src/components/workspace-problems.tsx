import type {
  ImportConflict,
  UnreadableAgent,
  UnreadableProject,
  WorkspaceProblem
} from '@shared/domain/workspace-problem'
import { Effect } from 'effect'
import { Loader2Icon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

type Unreadable = UnreadableProject | UnreadableAgent

const CONNECTION_LOST = "The connection to dia's background process was lost."

const log = (message: string, annotations: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const keyOf = (problem: WorkspaceProblem): string => {
  switch (problem._tag) {
    case 'UnreadableProject':
      return `project:${problem.projectId}`
    case 'UnreadableAgent':
      return `agent:${problem.agentId}`
    case 'ImportConflict':
      return `import:${problem.agentId}`
  }
}

const isUnreadable = (problem: WorkspaceProblem): problem is Unreadable =>
  problem._tag !== 'ImportConflict'

const agentsLabel = (count: number): string => (count === 1 ? '1 agent' : `${count} agents`)

/** The label of the import action for `conflict`, naming every value the import drops. */
export const importLabel = (conflict: ImportConflict): string => {
  if (conflict.session !== undefined && conflict.worktree !== undefined) {
    return 'Import without its session and worktree'
  }
  if (conflict.session !== undefined) return 'Import without its session'
  if (conflict.worktree !== undefined) return 'Import without its worktree'
  return 'Import'
}

const shortSession = (sessionId: string): string =>
  sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId

function ConflictReason({ conflict }: { conflict: ImportConflict }) {
  const { session, worktree } = conflict
  if (session === undefined && worktree === undefined) {
    return <>No other agent holds its session or worktree any more.</>
  }
  return (
    <>
      {session !== undefined && (
        <span className="block">
          Shares session{' '}
          <span className="font-mono" title={session.value}>
            {shortSession(session.value)}
          </span>{' '}
          with {session.heldBy}
        </span>
      )}
      {worktree !== undefined && (
        <span className="block">
          Shares worktree <span className="font-mono break-all">{worktree.value}</span> with{' '}
          {worktree.heldBy}
        </span>
      )}
    </>
  )
}

interface RowProps {
  readonly title: string
  readonly caption: string
  readonly reason: React.ReactNode
  readonly error: string | null
  readonly children: React.ReactNode
}

function ProblemRow({ title, caption, reason, error, children }: RowProps) {
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={title}>
            {title}
          </span>
          <span className="text-xs text-muted-foreground">{caption}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">{children}</div>
      </div>
      <div className="text-xs text-muted-foreground">{reason}</div>
      {error !== null && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </li>
  )
}

function DeleteRowDialog({
  problem,
  onDeleted,
  onClose
}: {
  problem: Unreadable
  onDeleted: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const isProject = problem._tag === 'UnreadableProject'

  const run = () => {
    setBusy(true)
    const row = isProject
      ? { kind: 'project' as const, id: problem.projectId }
      : { kind: 'agent' as const, id: problem.agentId }
    log('Deleting an unreadable stored row', row)
    window.dia.workspaceProblems.deleteRow(row).then(
      (reason) => {
        setBusy(false)
        if (reason === null) onDeleted()
        else setFailure(reason)
      },
      () => {
        setBusy(false)
        setFailure(CONNECTION_LOST)
      }
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
          <AlertDialogTitle>
            {isProject ? `Delete project ${problem.name}?` : `Delete agent ${problem.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>
                {isProject
                  ? `dia deletes what it stored about this project and its ${agentsLabel(problem.agents)}: their settings, worktree records and session history.`
                  : 'dia deletes what it stored about this agent: its settings, its worktree record and its session history.'}{' '}
                This cannot be undone.
              </p>
              <p>
                {isProject
                  ? 'The project directory, any worktree directories and the Claude Code transcripts stay on disk.'
                  : 'Its worktree directory, if it has one, and its Claude Code transcripts stay on disk.'}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failure !== null && (
          <p role="alert" className="text-sm text-error">
            Not deleted: {failure}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={run}>
            {busy && (
              <Loader2Icon
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            {busy ? 'Deleting…' : failure !== null ? 'Try again' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ProblemGroup({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="text-xs font-medium text-muted-foreground">{heading}</h3>
      <ul className="flex flex-col divide-y">{children}</ul>
    </section>
  )
}

/**
 * The app-wide strip that tells the user dia holds workspace problems they have not decided on:
 * stored agents and projects it could not load, and tabs it skipped when importing an older
 * workspace. `Review` opens a dialog listing each with its reason and actions: Keep for later
 * (hidden until dia restarts) or Delete (after a confirmation) for a stored row, and Import or
 * Discard for a skipped tab. Empty while there is nothing to decide. Place it above the content
 * area, under the account banner.
 */
export function WorkspaceProblemsBanner(): React.JSX.Element | null {
  const [problems, setProblems] = useState<ReadonlyArray<WorkspaceProblem>>([])
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [deleting, setDeleting] = useState<Unreadable | null>(null)

  const refresh = useCallback(() => {
    window.dia.workspaceProblems.list().then(setProblems, () => setProblems([]))
  }, [])

  useEffect(refresh, [refresh])

  const visible = problems.filter((problem) => !kept.has(keyOf(problem)))
  const unreadable = visible.filter(isUnreadable)
  const conflicts = visible.filter(
    (problem): problem is ImportConflict => problem._tag === 'ImportConflict'
  )

  const setError = (key: string, reason: string | null) =>
    setErrors((current) => {
      const { [key]: _removed, ...rest } = current
      return reason === null ? rest : { ...rest, [key]: reason }
    })

  const keep = (problem: Unreadable) => {
    const key = keyOf(problem)
    log('Kept a workspace problem for later', { key })
    setKept((current) => new Set([...current, key]))
  }

  const resolve = (conflict: ImportConflict, resolution: 'import' | 'discard') => {
    const key = keyOf(conflict)
    setBusy(key)
    setError(key, null)
    log('Resolving an import conflict', { agentId: conflict.agentId, resolution })
    window.dia.workspaceProblems.resolveImportConflict(conflict.agentId, resolution).then(
      (reason) => {
        setBusy(null)
        setError(key, reason)
        refresh()
      },
      () => {
        setBusy(null)
        setError(key, CONNECTION_LOST)
      }
    )
  }

  if (visible.length === 0) return null

  return (
    <div
      role="status"
      className="flex min-h-9 shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs text-ink-muted"
    >
      <span>
        {visible.length === 1
          ? 'A workspace problem needs your decision'
          : `${visible.length} workspace problems need your decision`}
      </span>
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)}>
        Review
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80vh] flex-col gap-4 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base">Workspace problems</DialogTitle>
            <DialogDescription>
              Decide what happens to each item. Nothing here is lost until you delete or discard it.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-6 flex min-h-0 flex-col gap-5 overflow-y-auto px-6">
            {unreadable.length > 0 && (
              <ProblemGroup heading="Could not be loaded">
                {unreadable.map((problem) => (
                  <ProblemRow
                    key={keyOf(problem)}
                    title={problem.name}
                    caption={
                      problem._tag === 'UnreadableProject'
                        ? `Project with ${agentsLabel(problem.agents)}`
                        : `Agent in ${problem.project}`
                    }
                    reason={
                      <span className="font-mono break-words whitespace-pre-wrap">
                        {problem.reason}
                      </span>
                    }
                    error={null}
                  >
                    <Button variant="ghost" size="sm" onClick={() => keep(problem)}>
                      Keep for later
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDeleting(problem)}>
                      Delete…
                    </Button>
                  </ProblemRow>
                ))}
              </ProblemGroup>
            )}
            {conflicts.length > 0 && (
              <ProblemGroup heading="Skipped when importing">
                {conflicts.map((conflict) => {
                  const key = keyOf(conflict)
                  const rowBusy = busy === key
                  return (
                    <ProblemRow
                      key={key}
                      title={conflict.name}
                      caption={`Tab in ${conflict.project}`}
                      reason={<ConflictReason conflict={conflict} />}
                      error={errors[key] ?? null}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => resolve(conflict, 'discard')}
                      >
                        Discard
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => resolve(conflict, 'import')}
                      >
                        {rowBusy && (
                          <Loader2Icon
                            data-icon="inline-start"
                            className="animate-spin motion-reduce:animate-none"
                          />
                        )}
                        {importLabel(conflict)}
                      </Button>
                    </ProblemRow>
                  )
                })}
              </ProblemGroup>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {deleting !== null && (
        <DeleteRowDialog
          problem={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}
