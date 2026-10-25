import {
  actions,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input
} from '@dia/renderer-plugin'
import type { ProjectEntry } from '@shared/domain/project'
import {
  type RemovalItem,
  type RemovalProgress,
  removalItemsOf
} from '@shared/domain/project-removal'
import { CheckIcon, CircleAlertIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'

type ItemState =
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Removing' }
  | { readonly _tag: 'Removed' }
  | { readonly _tag: 'Failed'; readonly reason: string }

type Phase = 'confirm' | 'removing' | 'failed' | 'lost'

/** Everything removing `entry` deletes, in the order the Host removes it. */
export const removalItems = (entry: ProjectEntry): ReadonlyArray<RemovalItem> =>
  entry.tabs.flatMap(removalItemsOf)

const itemKey = (item: RemovalItem): string => {
  switch (item._tag) {
    case 'AgentItem':
      return `agent:${item.paneId}`
    case 'WorktreeItem':
      return `worktree:${item.path}`
    case 'TranscriptItem':
      return `transcript:${item.sessionId}`
  }
}

const describe = (
  item: RemovalItem,
  entry: ProjectEntry
): { readonly kind: string; readonly text: string; readonly mono: boolean } => {
  switch (item._tag) {
    case 'AgentItem':
      return { kind: 'Agent', text: item.name, mono: false }
    case 'WorktreeItem':
      return { kind: 'Worktree', text: item.path, mono: true }
    case 'TranscriptItem': {
      const owner = entry.tabs.find((tab) => tab.sessionId === item.sessionId)
      return {
        kind: 'Transcript',
        text: owner === undefined ? item.sessionId : `of ${owner.name}`,
        mono: false
      }
    }
  }
}

function ItemStateIcon({ state }: { readonly state: ItemState }) {
  switch (state._tag) {
    case 'Pending':
      return <span aria-hidden className="size-3.5" />
    case 'Removing':
      return (
        <Loader2Icon
          aria-label="Removing"
          className="size-3.5 animate-spin text-ink-muted motion-reduce:animate-none"
        />
      )
    case 'Removed':
      return <CheckIcon aria-label="Removed" className="size-3.5 text-ink-muted" />
    case 'Failed':
      return <CircleAlertIcon aria-label="Not removed" className="size-3.5 text-error" />
  }
}

interface RemoveProjectDialogProps {
  readonly entry: ProjectEntry
  readonly onClose: () => void
}

/**
 * Confirms and runs the removal of a project. It lists every agent, worktree and transcript that
 * will be removed; typing the project name enables "Remove". During removal each item shows its
 * progress. When an item fails, "Remove again" retries and "Remove anyway" drops the project and
 * leaves the failed items on disk.
 */
export function RemoveProjectDialog({ entry, onClose }: RemoveProjectDialogProps) {
  const { project } = entry
  const items = removalItems(entry)
  const [phase, setPhase] = useState<Phase>('confirm')
  const [typed, setTyped] = useState('')
  const [states, setStates] = useState<ReadonlyMap<string, ItemState>>(new Map())

  const stateOf = (item: RemovalItem): ItemState => states.get(itemKey(item)) ?? { _tag: 'Pending' }

  const run = (force: boolean) => {
    setPhase('removing')
    setStates(new Map())
    let removed = false
    const onProgress = (progress: RemovalProgress) => {
      if (progress._tag === 'ProjectRemoved') {
        removed = true
        return
      }
      const next: ItemState =
        progress._tag === 'Removing'
          ? { _tag: 'Removing' }
          : progress._tag === 'Removed'
            ? { _tag: 'Removed' }
            : { _tag: 'Failed', reason: progress.reason }
      setStates((current) => new Map(current).set(itemKey(progress.item), next))
    }
    actions.removeProject(project.projectId, force, onProgress).then(
      () => (removed ? onClose() : setPhase('failed')),
      () => setPhase('lost')
    )
  }

  const busy = phase === 'removing'
  const confirmed = typed.trim() === project.displayName

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {project.displayName}?</DialogTitle>
          <DialogDescription>
            dia stops these agents and deletes their worktrees and transcripts. The project
            directory <span className="font-mono break-all">{project.directory}</span> stays on
            disk.
          </DialogDescription>
        </DialogHeader>

        {items.length === 0 ? (
          <p className="text-sm text-ink-muted">This project has no agents.</p>
        ) : (
          <ul aria-label="Items to remove" className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {items.map((item) => {
              const { kind, text, mono } = describe(item, entry)
              const state = stateOf(item)
              return (
                <li key={itemKey(item)} className="flex flex-col">
                  <div className="flex items-center gap-2 text-sm">
                    {phase !== 'confirm' && <ItemStateIcon state={state} />}
                    <span className="w-20 shrink-0 text-xs text-ink-muted">{kind}</span>
                    <span
                      title={text}
                      className={cn('truncate text-ink', mono && 'font-mono text-xs')}
                    >
                      {text}
                    </span>
                  </div>
                  {state._tag === 'Failed' && (
                    <p className="pl-[6.5rem] text-xs text-error">{state.reason}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {phase === 'confirm' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="remove-project-name" className="text-xs text-ink-muted">
              Type <span className="font-medium text-ink">{project.displayName}</span> to confirm
            </label>
            <Input
              id="remove-project-name"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && confirmed) run(false)
              }}
            />
          </div>
        )}
        {phase === 'failed' && (
          <p role="alert" className="text-sm text-ink">
            Some items were not removed. The project stays in the sidebar until they are.
          </p>
        )}
        {phase === 'lost' && (
          <p role="alert" className="text-sm text-ink">
            The connection to dia's background process was lost before removal finished.
          </p>
        )}

        <DialogFooter>
          {phase === 'confirm' && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={!confirmed} onClick={() => run(false)}>
                Remove
              </Button>
            </>
          )}
          {phase === 'removing' && (
            <Button disabled variant="destructive">
              <Loader2Icon
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
              Removing…
            </Button>
          )}
          {phase === 'failed' && (
            <>
              <Button variant="ghost" onClick={() => run(true)}>
                Remove anyway
              </Button>
              <Button variant="destructive" onClick={() => run(false)}>
                Remove again
              </Button>
            </>
          )}
          {phase === 'lost' && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => run(false)}>Check again</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
