import type { SendMode } from '@shared/domain/message-queue'
import { Duration, Effect, Queue, Stream, SubscriptionRef } from 'effect'
import { Atom } from 'effect/reactivity'
import type { PaneChatState, PaneStreamEvent } from './pane-chat'
import { emptyPaneChatState, paneChatStateFromHistory, reducePaneChat } from './pane-chat'

const IDLE_TTL = Duration.seconds(30)

const paneStreamEvents = (paneId: string): Stream.Stream<PaneStreamEvent> =>
  Stream.callback<PaneStreamEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const push = (event: PaneStreamEvent): void => {
          if (event.paneId === paneId) Queue.offerUnsafe(queue, event)
        }
        return [
          window.dia.onAssistantTextDelta(push),
          window.dia.onAssistantThinkingDelta(push),
          window.dia.onToolCallStarted(push),
          window.dia.onToolCallCompleted(push),
          window.dia.onMessageAppended(push),
          window.dia.onAttentionChanged(push),
          window.dia.onSlashCommandsWarming(push),
          window.dia.onSlashCommandsAvailable(push),
          window.dia.onConversationCompacted(push),
          window.dia.onConversationReset(push),
          window.dia.onCheckpointAvailable(push),
          window.dia.onRewoundToCheckpoint(push),
          window.dia.onMessageQueueChanged(push),
          window.dia.onUserMessagesSent(push)
        ]
      }),
      (unsubscribes) =>
        Effect.sync(() => {
          for (const unsubscribe of unsubscribes) unsubscribe()
        })
    )
  )

const paneHistoryReloads = (paneId: string): Stream.Stream<void> =>
  Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        window.dia.onHistoryReloadRequested((reloadedPaneId) => {
          if (reloadedPaneId === paneId) Queue.offerUnsafe(queue, undefined)
        })
      ),
      (unsubscribe) => Effect.sync(unsubscribe)
    )
  )

/**
 * Per-pane conversation-state atom, keyed by `paneId`. Reading it yields a
 * `AsyncResult` of {@link PaneChatState}: pending until the pane's history loads,
 * then success. On construction it fetches the pane's history, seeds a
 * `SubscriptionRef`, and forks a continuous subscription that folds every
 * `window.dia.on*` event for the pane into state via {@link reducePaneChat}.
 *
 * The atom lives in the process-global atom registry, outside the React
 * tree, so a component remount (e.g. splitting a pane) re-attaches to the same
 * atom and its still-running subscription — streaming never drops. The forked
 * subscription is released only when the atom is disposed, which idle-TTL defers
 * until the pane is truly gone.
 *
 * The event subscription is attached *before* the history fetch, and the fetched
 * history and the pane's message queue are then folded in while preserving any slash-command
 * state the stream already delivered. This closes a resume race: a freshly resumed pane warms up
 * its slash commands as soon as its process spawns, and that push would be lost
 * if it landed during the (async) history round-trip on a not-yet-subscribed atom.
 *
 * When the Host reports it can no longer replay what this pane missed while disconnected
 * (`onHistoryReloadRequested`), the history and queue are fetched again and replace the pane's
 * messages and queue, again preserving slash-command state.
 */
export const paneChatAtom = Atom.family((paneId: string) =>
  Atom.subscriptionRef(
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(emptyPaneChatState)
      yield* paneStreamEvents(paneId).pipe(
        Stream.runForEach((event) =>
          SubscriptionRef.update(ref, (state) => reducePaneChat(state, event))
        ),
        Effect.forkScoped
      )
      yield* Effect.logDebug('pane chat subscription established').pipe(
        Effect.annotateLogs({ paneId })
      )
      const loadHistory = Effect.gen(function* () {
        const [history, queue] = yield* Effect.all(
          [
            Effect.promise(() => window.dia.getPaneHistory(paneId)),
            Effect.promise(() => window.dia.getMessageQueue(paneId))
          ],
          { concurrency: 'unbounded' }
        )
        yield* SubscriptionRef.update(ref, (state) => ({
          ...paneChatStateFromHistory(paneId, history),
          slashCommands: state.slashCommands,
          warmingCommands: state.warmingCommands,
          queued: queue.queued,
          queueHeld: queue.held
        }))
      })
      yield* paneHistoryReloads(paneId).pipe(
        Stream.runForEach(() =>
          Effect.logInfo('pane history reload requested by the Host').pipe(
            Effect.annotateLogs({ paneId }),
            Effect.andThen(loadHistory)
          )
        ),
        Effect.forkScoped
      )
      yield* loadHistory
      yield* Effect.addFinalizer(() =>
        Effect.logDebug('pane chat subscription released').pipe(Effect.annotateLogs({ paneId }))
      )
      return ref
    })
  ).pipe(Atom.setIdleTTL(IDLE_TTL))
)

/** A user prompt and the {@link SendMode} to deliver it in. */
export interface SendRequest {
  readonly text: string
  readonly mode: SendMode
}

/**
 * Per-pane send action, keyed by `paneId`. Set it with a {@link SendRequest} to
 * dispatch the prompt to the pane process via `window.dia.sendMessage`. The
 * user turn appears in {@link paneChatAtom} when the pane reports it sent, or in
 * the pane's queue when it waits for the running turn. Bind with
 * `useAtomSet(paneSendAtom(paneId))`.
 */
export const paneSendAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    (_ctx, request: SendRequest) => {
      window.dia.sendMessage(paneId, request.text, request.mode)
    }
  )
)

/** A queued message's id and its replacement text. */
export interface QueuedMessageEdit {
  readonly messageId: string
  readonly text: string
}

/**
 * Per-pane action that replaces the text of a queued message, keyed by
 * `paneId`. The new queue arrives back through {@link paneChatAtom}. Bind with
 * `useAtomSet(paneEditQueuedAtom(paneId))`.
 */
export const paneEditQueuedAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    (_ctx, edit: QueuedMessageEdit) => {
      window.dia.editQueuedMessage(paneId, edit.messageId, edit.text)
    }
  )
)

/**
 * Per-pane action that removes a queued message by id, keyed by `paneId`. The
 * new queue arrives back through {@link paneChatAtom}. Bind with
 * `useAtomSet(paneRemoveQueuedAtom(paneId))`.
 */
export const paneRemoveQueuedAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    (_ctx, messageId: string) => {
      window.dia.removeQueuedMessage(paneId, messageId)
    }
  )
)

/** The pair of uuids identifying a rewind target: the user turn's checkpoint id and, when a prior assistant turn exists, the branch point to resume from. */
export interface RewindTarget {
  readonly checkpointUuid: string
  readonly resumeAnchorUuid?: string
}

/**
 * Per-pane rewind action, keyed by `paneId`. Set it with a {@link RewindTarget}
 * (a user turn's `checkpointUuid` and optional `resumeAnchorUuid`) to rewind that
 * pane's files and conversation back to that point (ADR-0018). It dispatches the
 * request to the pane process; the resulting transcript truncation arrives back
 * through the IPC fold on `PaneRewoundToCheckpoint`. A prompt sent through
 * {@link paneSendAtom} while the rewind runs waits for it, is sent to the
 * conversation the rewind leaves, and its user turn arrives after the truncation.
 * A prompt the pane reported sent before the rewind started is dropped with the
 * turns after the checkpoint. Bind with
 * `useAtomSet(paneRewindAtom(paneId))`.
 */
export const paneRewindAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    (_ctx, target: RewindTarget) => {
      window.dia.rewindToCheckpoint(paneId, target.checkpointUuid, target.resumeAnchorUuid)
    }
  )
)
