import type { SendMode } from '@shared/domain/message-queue'
import type { ModelCatalogSnapshotJson, PaneModelChanged } from '@shared/ipc/contract'
import { Clock, Duration, Effect, Queue, Stream, SubscriptionRef } from 'effect'
import { Atom } from 'effect/reactivity'
import { findModelOption } from './model-options'
import type { PaneChatState, PaneStreamEvent } from './pane-chat'
import { emptyPaneChatState, paneChatStateFromHistory, reducePaneChat } from './pane-chat'
import { type RewindCommand, type RewindProgress, rewindFailureMessage } from './pane-rewind'

const IDLE_TTL = Duration.seconds(30)

const displayNameIn = (
  catalog: ModelCatalogSnapshotJson | undefined,
  model: string
): string | undefined => findModelOption(catalog?.state, model)?.displayName

const paneStreamEvents = (paneId: string): Stream.Stream<PaneStreamEvent> =>
  Stream.callback<PaneStreamEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let catalog: ModelCatalogSnapshotJson | undefined
        const keepCatalog = (next: ModelCatalogSnapshotJson): void => {
          if (catalog === undefined || next.revision > catalog.revision) catalog = next
        }
        const push = (event: PaneStreamEvent): void => {
          if (event.paneId === paneId) Queue.offerUnsafe(queue, event)
        }
        const pushModelChange = (event: PaneModelChanged): void =>
          push({ ...event, displayName: displayNameIn(catalog, event.model) })
        const stopCatalog = window.dia.models.onChanged(keepCatalog)
        void window.dia.models.get().then(keepCatalog)
        return [
          stopCatalog,
          window.dia.onModelChanged(pushModelChange),
          window.dia.onAssistantTextDelta(push),
          window.dia.onAssistantThinkingDelta(push),
          window.dia.onToolCallStarted(push),
          window.dia.onToolCallCompleted(push),
          window.dia.onToolCallUpdated(push),
          window.dia.onTurnStatusChanged(push),
          window.dia.onSessionNotice(push),
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
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            yield* SubscriptionRef.update(ref, (state) => reducePaneChat(state, event, now))
          })
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

/**
 * Per-pane stop action, keyed by `paneId`. Set it (with no argument) to abort
 * the pane's in-flight turn: it dispatches `window.dia.interrupt`, which
 * supersedes any pending prompt, cancels generation in the pane process and
 * holds the pane's queued messages until the next send. The turn end and the
 * held queue arrive back through {@link paneChatAtom}'s IPC fold, so this
 * performs no optimistic state change. Bind with
 * `useAtomSet(paneInterruptAtom(paneId))`.
 */
export const paneInterruptAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    // biome-ignore lint/suspicious/noConfusingVoidType: no-argument trigger — void lets callers invoke the setter as interrupt() with no value
    (_ctx, _trigger: void) => {
      window.dia.interrupt(paneId)
    }
  )
)

const REWIND_OUTCOME_TIMEOUT = Duration.seconds(45)

const idle: RewindProgress = { status: 'idle' }

const logRewind = (message: string, annotations: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

/**
 * Per-pane rewind state and action, keyed by `paneId` (ADR-0018, ADR-0045). Read it for the pane's
 * {@link RewindProgress}; set it with a {@link RewindCommand}. `start` sends the rewind to the pane
 * process and shows it `rewinding`; it does nothing while a rewind runs. The rewind ends `idle`
 * when the pane reports `PaneRewoundToCheckpoint` (the transcript truncation arrives through
 * {@link paneChatAtom}), or `failed` with a sentence to show when the pane reports
 * `PaneRewindFailed` or reports nothing within 45 seconds. It also ends `idle` when the pane
 * crashes, errors or reloads its history, since its outcome is then unknown. `dismiss` clears a
 * failure. A prompt sent through {@link paneSendAtom} while the rewind runs waits for it and is
 * sent to the conversation the rewind leaves. The atom is kept alive for the renderer's lifetime,
 * so a failure that arrives while the pane's tab is hidden is still shown. Bind with
 * `useAtom(paneRewindAtom(paneId))`.
 */
export const paneRewindAtom = Atom.family((paneId: string) => {
  let current: RewindProgress = idle
  let timer: ReturnType<typeof setTimeout> | undefined
  let setSelf: (next: RewindProgress) => void = () => undefined

  const transition = (next: RewindProgress): void => {
    if (next.status !== 'rewinding' && timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    current = next
    setSelf(next)
    logRewind('Rewind progress changed', {
      paneId,
      status: next.status,
      checkpointUuid: next.status === 'idle' ? undefined : next.checkpointUuid
    })
  }
  const isRewinding = (checkpointUuid?: string): boolean =>
    current.status === 'rewinding' &&
    (checkpointUuid === undefined || current.checkpointUuid === checkpointUuid)

  return Atom.writable(
    (get): RewindProgress => {
      clearTimeout(timer)
      timer = undefined
      current = idle
      setSelf = (next) => get.setSelf(next)
      const unsubscribes = [
        window.dia.onRewindFailed((event) => {
          if (event.paneId !== paneId || !isRewinding(event.messageUuid)) return
          transition({
            status: 'failed',
            checkpointUuid: event.messageUuid,
            message: rewindFailureMessage(event.cause, event.detail)
          })
        }),
        window.dia.onRewoundToCheckpoint((event) => {
          if (event.paneId !== paneId || current.status === 'idle') return
          if (current.checkpointUuid === event.messageUuid) transition(idle)
        }),
        window.dia.onAttentionChanged((event) => {
          if (event.paneId !== paneId || !isRewinding()) return
          if (event.attention._tag === 'Crashed' || event.attention._tag === 'Errored') {
            transition(idle)
          }
        }),
        window.dia.onHistoryReloadRequested((reloadedPaneId) => {
          if (reloadedPaneId === paneId && isRewinding()) transition(idle)
        })
      ]
      get.addFinalizer(() => {
        for (const unsubscribe of unsubscribes) unsubscribe()
        clearTimeout(timer)
      })
      return current
    },
    (_ctx, command: RewindCommand) => {
      if (command.type === 'dismiss') {
        if (current.status === 'failed') transition(idle)
        return
      }
      if (isRewinding()) return
      const { checkpointUuid, resumeAnchorUuid } = command.target
      transition({ status: 'rewinding', checkpointUuid })
      // @effect-diagnostics-next-line globalTimers:off -- an atom's write function runs outside an Effect runtime; its finalizer clears the timer.
      timer = setTimeout(
        () =>
          transition({
            status: 'failed',
            checkpointUuid,
            message: 'Rewind failed: the agent did not respond.'
          }),
        Duration.toMillis(REWIND_OUTCOME_TIMEOUT)
      )
      window.dia.rewindToCheckpoint(paneId, checkpointUuid, resumeAnchorUuid)
    }
  ).pipe(Atom.keepAlive)
})
