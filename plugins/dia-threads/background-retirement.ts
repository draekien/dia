import { actions, toast } from '@dia/renderer-plugin'
import type { PaneId } from '@shared/domain/pane'
import { Effect } from 'effect'
import { useSyncExternalStore } from 'react'

/** Which change is made to a thread: archiving it, or deleting it. */
export type Retirement = 'archive' | 'delete'

/** The thread a retirement applies to: its pane and the name the failure toast shows. */
export interface RetirementTarget {
  readonly paneId: PaneId
  readonly name: string
}

/** The words for each retirement: the button verb, the in-progress text, and the failure toast title for a thread named `name`. */
export const RETIREMENT_COPY: Record<
  Retirement,
  {
    readonly verb: string
    readonly running: string
    readonly failedTitle: (name: string) => string
  }
> = {
  archive: {
    verb: 'Archive',
    running: 'Archiving…',
    failedTitle: (name) => `Could not archive ${name}`
  },
  delete: {
    verb: 'Delete',
    running: 'Deleting…',
    failedTitle: (name) => `Could not delete ${name}`
  }
}

const LOST_CONNECTION = "The connection to dia's background process was lost."

let running: ReadonlyMap<PaneId, Retirement> = new Map()
const failureToasts = new Map<PaneId, string>()
const listeners = new Set<() => void>()

const setRunning = (next: ReadonlyMap<PaneId, Retirement>) => {
  running = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const finish = (paneId: PaneId) => {
  const next = new Map(running)
  next.delete(paneId)
  setRunning(next)
}

const reportFailure = (target: RetirementTarget, retirement: Retirement, reason: string) => {
  Effect.runFork(
    Effect.logWarning('A thread was not retired', { paneId: target.paneId, retirement, reason })
  )
  const id = toast.add({
    title: RETIREMENT_COPY[retirement].failedTitle(target.name),
    description: reason,
    type: 'error',
    timeout: 0,
    actionProps: {
      children: 'Try again',
      onClick: () => retireInBackground(target, retirement)
    },
    onClose: () => {
      if (failureToasts.get(target.paneId) === id) failureToasts.delete(target.paneId)
    }
  })
  failureToasts.set(target.paneId, id)
}

/**
 * Starts archiving or deleting `target` without waiting for it. While the host works,
 * {@link useRetirement} returns `retirement` for the target's pane. When the host refuses or the
 * connection is lost, shows one error toast naming the thread with a `Try again` action. A call for
 * a pane that is already being retired is ignored. Call it only after the user has confirmed.
 */
export const retireInBackground = (target: RetirementTarget, retirement: Retirement): void => {
  const { paneId } = target
  if (running.has(paneId)) {
    Effect.runFork(Effect.logDebug('Ignored a retirement already running', { paneId, retirement }))
    return
  }
  const earlierToast = failureToasts.get(paneId)
  if (earlierToast !== undefined) {
    failureToasts.delete(paneId)
    toast.close(earlierToast)
  }
  setRunning(new Map(running).set(paneId, retirement))
  Effect.runFork(Effect.logInfo('Retiring a thread in the background', { paneId, retirement }))
  const change = retirement === 'archive' ? actions.archiveTab : actions.deleteTab
  change(paneId)
    .catch(() => LOST_CONNECTION)
    .then((reason) => {
      finish(paneId)
      if (reason === null) {
        Effect.runFork(Effect.logInfo('Retired a thread', { paneId, retirement }))
        return
      }
      reportFailure(target, retirement, reason)
    })
}

/** The retirement in progress for `paneId`, or `null`. Re-renders the caller when it starts or ends. */
export function useRetirement(paneId: PaneId): Retirement | null {
  return useSyncExternalStore(subscribe, () => running.get(paneId) ?? null)
}
