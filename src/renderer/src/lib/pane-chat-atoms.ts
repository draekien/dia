import type { Attachment } from '@shared/domain/attachment'
import type { SendMode } from '@shared/domain/message-queue'
import {
  isPaneStreamEvent,
  type PaneChatState,
  type PaneStreamEvent,
  reducePaneChat
} from '@shared/domain/pane-chat'
import type { ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import type { PaneEventFrame } from '@shared/ipc/rpc'
import { Clock, Duration, Effect, Queue, Ref, type Scope, Stream, SubscriptionRef } from 'effect'
import { Atom } from 'effect/reactivity'
import { findModelOption } from './model-options'
import { type RewindCommand, type RewindProgress, rewindFailureMessage } from './pane-rewind'

const IDLE_TTL = Duration.seconds(30)

const RELOAD = 'reload'

type PaneFeedItem = PaneEventFrame | typeof RELOAD

const withDisplayName = (
  catalog: ModelCatalogSnapshotJson | undefined,
  event: PaneStreamEvent
): PaneStreamEvent =>
  event._tag === 'PaneModelChanged'
    ? { ...event, displayName: findModelOption(catalog?.state, event.model)?.displayName }
    : event

const paneFeed = (
  paneId: string,
  queue: Queue.Queue<PaneFeedItem>
): Effect.Effect<() => ModelCatalogSnapshotJson | undefined, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let catalog: ModelCatalogSnapshotJson | undefined
      const keepCatalog = (next: ModelCatalogSnapshotJson): void => {
        if (catalog === undefined || next.revision > catalog.revision) catalog = next
      }
      void window.dia.models.get().then(keepCatalog)
      const unsubscribes = [
        window.dia.models.onChanged(keepCatalog),
        window.dia.onPaneEvent((frame) => {
          if (frame.paneId === paneId) Queue.offerUnsafe(queue, frame)
        }),
        window.dia.onHistoryReloadRequested((reloadedPaneId) => {
          if (reloadedPaneId === paneId) Queue.offerUnsafe(queue, RELOAD)
        })
      ]
      return { unsubscribes, currentCatalog: () => catalog }
    }),
    ({ unsubscribes }) =>
      Effect.sync(() => {
        for (const unsubscribe of unsubscribes) unsubscribe()
      })
  ).pipe(Effect.map(({ currentCatalog }) => currentCatalog))

/**
 * Per-pane conversation-state atom, keyed by `paneId`. Reading it yields an `AsyncResult` of
 * {@link PaneChatState}: pending until the Host's snapshot of the pane arrives, then success.
 * The state then follows every event the Host sends for the pane, and is replaced by a fresh
 * snapshot when the Host reports it can no longer replay what the pane missed
 * (`onHistoryReloadRequested`).
 *
 * The atom lives in the process-global atom registry, outside the React tree, so a component
 * remount re-attaches to the same atom. It is disposed 30 seconds after its last reader leaves;
 * the next read starts again from the Host's snapshot, which holds the pane's full state.
 */
export const paneChatAtom = Atom.family((paneId: string) =>
  Atom.subscriptionRef(
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<PaneFeedItem>()
      const currentCatalog = yield* paneFeed(paneId, feed)
      const floor = yield* Ref.make(0)
      const loadSnapshot = Effect.gen(function* () {
        const snapshot = yield* Effect.promise(() => window.dia.getPaneChat(paneId))
        yield* Ref.set(floor, snapshot.seq)
        yield* Effect.logDebug('Applied the pane chat snapshot', { paneId, seq: snapshot.seq })
        return snapshot.state
      })
      const ref = yield* SubscriptionRef.make<PaneChatState>(yield* loadSnapshot)
      const apply = (item: PaneFeedItem) =>
        Effect.gen(function* () {
          if (item === RELOAD) {
            yield* Effect.logInfo('Pane chat reload requested by the Host', { paneId })
            yield* SubscriptionRef.set(ref, yield* loadSnapshot)
            return
          }
          if (item.seq <= (yield* Ref.get(floor))) return
          yield* Ref.set(floor, item.seq)
          if (!isPaneStreamEvent(item.event)) return
          const event = withDisplayName(currentCatalog(), item.event)
          const now = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(ref, (state) => reducePaneChat(state, event, now))
        })
      yield* Stream.fromQueue(feed).pipe(Stream.runForEach(apply), Effect.forkScoped)
      yield* Effect.addFinalizer(() =>
        Effect.logDebug('Pane chat subscription released', { paneId })
      )
      return ref
    })
  ).pipe(Atom.setIdleTTL(IDLE_TTL))
)

/** A user prompt and the {@link SendMode} to deliver it in. */
export interface SendRequest {
  readonly text: string
  readonly mode: SendMode
  readonly attachments?: ReadonlyArray<Attachment>
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
      window.dia.sendMessage(paneId, request.text, request.mode, request.attachments)
    }
  )
)

/** A queued message's id, its replacement text, and the attachments it keeps when given. */
export interface QueuedMessageEdit {
  readonly messageId: string
  readonly text: string
  readonly attachments?: ReadonlyArray<Attachment>
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
      window.dia.editQueuedMessage(paneId, edit.messageId, edit.text, edit.attachments)
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
 * Per-pane action that sends a queued message now instead of after the running turn, keyed by
 * `paneId`. During a turn it steers the turn with that message; the rest of the queue keeps
 * waiting. The new queue arrives back through {@link paneChatAtom}. Bind with
 * `useAtomSet(paneSendQueuedNowAtom(paneId))` and set it to the message id.
 */
export const paneSendQueuedNowAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    (_ctx, messageId: string) => {
      window.dia.sendQueuedMessageNow(paneId, messageId)
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
    Effect.runSync(
      Effect.logDebug('Rewind progress changed', {
        paneId,
        status: next.status,
        checkpointUuid: next.status === 'idle' ? undefined : next.checkpointUuid
      })
    )
  }
  const abandonRewind = (): void => {
    if (current.status === 'rewinding') transition(idle)
  }

  return Atom.writable(
    (get): RewindProgress => {
      clearTimeout(timer)
      timer = undefined
      current = idle
      setSelf = (next) => get.setSelf(next)
      const unsubscribes = [
        window.dia.onRewindFailed((event) => {
          if (event.paneId !== paneId) return
          if (current.status === 'idle' || current.checkpointUuid !== event.messageUuid) return
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
          if (event.paneId !== paneId) return
          if (event.attention._tag === 'Crashed' || event.attention._tag === 'Errored') {
            abandonRewind()
          }
        }),
        window.dia.onHistoryReloadRequested((reloadedPaneId) => {
          if (reloadedPaneId === paneId) abandonRewind()
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
      if (current.status === 'rewinding') return
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
