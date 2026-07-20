import { Atom, Result } from '@effect-atom/atom'
import { Duration, Effect, Stream, SubscriptionRef } from 'effect'
import type { PaneChatState, PaneStreamEvent } from './pane-chat'
import {
  appendUserMessage,
  emptyPaneChatState,
  paneChatStateFromHistory,
  reducePaneChat
} from './pane-chat'

const IDLE_TTL = Duration.seconds(30)

const paneStreamEvents = (paneId: string): Stream.Stream<PaneStreamEvent> =>
  Stream.asyncPush<PaneStreamEvent>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const push = (event: PaneStreamEvent): void => {
          if (event.paneId === paneId) emit.single(event)
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
          window.dia.onRewoundToCheckpoint(push)
        ]
      }),
      (unsubscribes) =>
        Effect.sync(() => {
          for (const unsubscribe of unsubscribes) unsubscribe()
        })
    )
  )

/**
 * Per-pane conversation-state atom, keyed by `paneId`. Reading it yields a
 * `Result` of {@link PaneChatState}: pending until the pane's history loads,
 * then success. On construction it fetches the pane's history, seeds a
 * `SubscriptionRef`, and forks a continuous subscription that folds every
 * `window.dia.on*` event for the pane into state via {@link reducePaneChat}.
 *
 * The atom lives in the process-global effect-atom registry, outside the React
 * tree, so a component remount (e.g. splitting a pane) re-attaches to the same
 * atom and its still-running subscription — streaming never drops. The forked
 * subscription is released only when the atom is disposed, which idle-TTL defers
 * until the pane is truly gone. Write a new {@link PaneChatState} to set state
 * directly (used by {@link paneSendAtom} for optimistic user appends).
 *
 * The event subscription is attached *before* the history fetch, and the fetched
 * history is then folded in while preserving any slash-command state the stream
 * already delivered. This closes a resume race: a freshly resumed pane warms up
 * its slash commands as soon as its process spawns, and that push would be lost
 * if it landed during the (async) history round-trip on a not-yet-subscribed atom.
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
      const history = yield* Effect.promise(() => window.dia.getPaneHistory(paneId))
      yield* SubscriptionRef.update(ref, (state) => ({
        ...paneChatStateFromHistory(paneId, history),
        slashCommands: state.slashCommands,
        warmingCommands: state.warmingCommands
      }))
      yield* Effect.addFinalizer(() =>
        Effect.logDebug('pane chat subscription released').pipe(Effect.annotateLogs({ paneId }))
      )
      return ref
    })
  ).pipe(Atom.setIdleTTL(IDLE_TTL))
)

const nextUserMessageId = (paneId: string, state: PaneChatState): string =>
  `${paneId}:user:${state.messages.length}`

/**
 * Per-pane send action, keyed by `paneId`. Set it with the prompt `text` to
 * submit a user turn: it optimistically appends the user message to
 * {@link paneChatAtom} and dispatches the prompt to the pane process via
 * `window.dia.sendMessage`. The assistant reply arrives back through the same
 * atom's IPC fold. Bind with `useAtomSet(paneSendAtom(paneId))`.
 */
export const paneSendAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    (ctx, text: string) => {
      const current = Result.getOrElse(ctx.get(paneChatAtom(paneId)), () => emptyPaneChatState)
      ctx.set(
        paneChatAtom(paneId),
        appendUserMessage(current, nextUserMessageId(paneId, current), text)
      )
      window.dia.sendMessage(paneId, text)
    }
  )
)

/**
 * Per-pane interrupt action, keyed by `paneId`. Set it (with no argument) to
 * abort the pane's in-flight turn: it dispatches `window.dia.interrupt`, which
 * supersedes any pending prompt and cancels generation in the pane process. The
 * resulting turn end arrives back through {@link paneChatAtom}'s IPC fold, so
 * this performs no optimistic state change. Bind with
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
 * through {@link paneChatAtom}'s IPC fold on `PaneRewoundToCheckpoint`, so this
 * performs no optimistic state change. Bind with `useAtomSet(paneRewindAtom(paneId))`.
 */
export const paneRewindAtom = Atom.family((paneId: string) =>
  Atom.writable(
    (): null => null,
    (_ctx, target: RewindTarget) => {
      window.dia.rewindToCheckpoint(paneId, target.checkpointUuid, target.resumeAnchorUuid)
    }
  )
)
