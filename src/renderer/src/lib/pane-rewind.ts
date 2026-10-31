import type { RewindFailureCause } from '@shared/domain/rewind'
import type { PaneMessage } from './pane-chat'

/** The pair of uuids identifying a rewind target: the user turn's checkpoint id and, when a prior assistant turn exists, the branch point to resume from. */
export interface RewindTarget {
  readonly checkpointUuid: string
  readonly resumeAnchorUuid?: string
}

/**
 * A pane's rewind as the renderer last saw it: none running (`idle`), one running to
 * `checkpointUuid` (`rewinding`), or the last one to `checkpointUuid` failed with `message`, a
 * sentence to show the user (`failed`). Read it from `paneRewindAtom`.
 */
export type RewindProgress =
  | { readonly status: 'idle' }
  | { readonly status: 'rewinding'; readonly checkpointUuid: string }
  | { readonly status: 'failed'; readonly checkpointUuid: string; readonly message: string }

/** What `paneRewindAtom` accepts: start a rewind to `target`, or dismiss the shown failure. */
export type RewindCommand =
  | { readonly type: 'start'; readonly target: RewindTarget }
  | { readonly type: 'dismiss' }

/**
 * What one agent turn's rewind row shows: its rewind control (`ready`), the control disabled
 * because another row's rewind runs (`blocked`), its own rewind running (`rewinding`), or its own
 * rewind's failure `message` (`failed`). Get it from {@link rewindRowState}.
 */
export type RewindRowState =
  | { readonly status: 'ready' }
  | { readonly status: 'blocked' }
  | { readonly status: 'rewinding' }
  | { readonly status: 'failed'; readonly message: string }

const isRewindableUserTurn = (
  message: PaneMessage
): message is PaneMessage & { readonly checkpointUuid: string } =>
  message.role === 'user' && message.checkpointUuid !== undefined && message.rewindable !== false

const precedingReply = (
  messages: ReadonlyArray<PaneMessage>,
  before: number
): PaneMessage | undefined => {
  for (let index = before - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'assistant') return message
    if (message.role === 'user' || message.compaction !== undefined) return undefined
  }
  return undefined
}

/**
 * For each agent turn the user may rewind to, the {@link RewindTarget} that keeps that turn and
 * discards everything after it, keyed by the agent message's `id`. Pass a pane's
 * `PaneChatState.messages`. An agent turn gets an entry only when a rewindable user turn follows
 * it with no other user turn and no compaction between them, so the last agent turn and turns
 * before a compaction get none.
 */
export const rewindTargets = (
  messages: ReadonlyArray<PaneMessage>
): ReadonlyMap<string, RewindTarget> => {
  const targets = new Map<string, RewindTarget>()
  messages.forEach((message, index) => {
    if (!isRewindableUserTurn(message)) return
    const reply = precedingReply(messages, index)
    if (reply === undefined) return
    targets.set(reply.id, {
      checkpointUuid: message.checkpointUuid,
      ...(message.resumeAnchorUuid !== undefined
        ? { resumeAnchorUuid: message.resumeAnchorUuid }
        : {})
    })
  })
  return targets
}

/**
 * What the rewind row for `target` shows, given the pane's current {@link RewindProgress}. Call it
 * once per row from the pane's progress.
 */
export const rewindRowState = (progress: RewindProgress, target: RewindTarget): RewindRowState => {
  if (progress.status === 'idle') return { status: 'ready' }
  const own = progress.checkpointUuid === target.checkpointUuid
  if (progress.status === 'rewinding') return { status: own ? 'rewinding' : 'blocked' }
  return own ? { status: 'failed', message: progress.message } : { status: 'ready' }
}

const failureText: Record<RewindFailureCause, string> = {
  NoLiveSession: 'the session is not running.',
  TurnNotInTranscript: 'this turn is no longer in the session transcript.',
  FilesNotRewound: 'the files could not be restored.',
  ConversationNotBranched: 'files were restored, but the conversation could not be branched.',
  Interrupted: 'the rewind was interrupted.'
}

/**
 * The sentence to show for a rewind that failed with `cause`, e.g.
 * `Rewind failed: the session is not running.`. Pass the Agent SDK's `detail`, when the failure
 * carries one, to show it in place of the generic text for files that could not be restored.
 */
export const rewindFailureMessage = (cause: RewindFailureCause, detail?: string): string =>
  `Rewind failed: ${cause === 'FilesNotRewound' && detail !== undefined ? detail : failureText[cause]}`
