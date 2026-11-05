import type { PaneId } from '@shared/domain/pane'
import {
  emptyPaneChatState,
  isPaneStreamEvent,
  type PaneChatSnapshot,
  type PaneChatState,
  type PaneStreamEvent,
  paneChatStateFromItems,
  reducePaneChat
} from '@shared/domain/pane-chat'
import type { Tab, Workspace } from '@shared/domain/project'
import * as WorkspaceOps from '@shared/domain/workspace'
import type { IpcEvent } from '@shared/ipc/contract'
import type { EventFrame, PaneEventFrame } from '@shared/ipc/rpc'
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Semaphore,
  Stream,
  SubscriptionRef
} from 'effect'
import { AgentEventRecorder } from './agent-event-recorder'
import { AgentEventStore } from './agent-event-store'
import { EventHub } from './event-hub'
import { ModelCatalogFeed } from './model-catalog-feed'
import { WorkspaceFeed } from './workspace-feed'

/**
 * The chat state of every workspace tab, folded from the Host's pane events on top of the tab's
 * stored conversation. Read a tab's state with `snapshot`. Call `seed` before starting a session for a
 * tab. Provide it with {@link PaneChatProjectionLive}.
 */
export class PaneChatProjection extends Context.Service<
  PaneChatProjection,
  {
    /**
     * The tab's chat state and the sequence number of the last event in it. A workspace tab with
     * no state yet is seeded from its stored conversation first; an id that is not a workspace tab gets
     * the empty state and `seq` 0, and nothing is kept for it.
     */
    readonly snapshot: (paneId: PaneId) => Effect.Effect<PaneChatSnapshot>
    /**
     * Gives the pane state unless it already has some, built from the pane's stored conversation.
     * A workspace tab with a session first imports the turns its transcript holds that are not
     * stored yet (turns added outside dia). Call it before a session for the pane starts.
     */
    readonly seed: (paneId: PaneId) => Effect.Effect<void>
  }
>()('PaneChatProjection') {}

interface Entry {
  readonly state: PaneChatState
  readonly seq: number
  readonly inWorkspace: boolean
}

const CATCH_UP_LIMIT = Duration.seconds(2)

const paneIdsOf = (workspace: Workspace): ReadonlySet<PaneId> =>
  new Set(workspace.projects.flatMap((entry) => entry.tabs.map((tab) => tab.config.paneId)))

/** Live {@link PaneChatProjection}; follows the `EventHub` for the layer's lifetime. */
export const PaneChatProjectionLive = Layer.effect(
  PaneChatProjection,
  Effect.gen(function* () {
    const hub = yield* EventHub
    const workspaceFeed = yield* WorkspaceFeed
    const store = yield* AgentEventStore
    const recorder = yield* AgentEventRecorder
    const modelCatalog = yield* ModelCatalogFeed
    const entries = yield* SubscriptionRef.make<ReadonlyMap<PaneId, Entry>>(new Map())
    const lock = yield* Semaphore.make(1)

    const storedHistory = (paneId: PaneId) =>
      store.readHistory(paneId).pipe(
        Effect.map(({ items, through }) => ({
          state: paneChatStateFromItems(items),
          seq: through
        })),
        Effect.catch((error) =>
          Effect.logError('Could not read pane history; serving it empty until a read succeeds', {
            paneId,
            error
          }).pipe(Effect.as(undefined))
        )
      )

    const insertIfAbsent = (paneId: PaneId, inWorkspace: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(entries)).has(paneId)) return undefined
          const history = yield* storedHistory(paneId)
          if (history === undefined) return undefined
          const { state, seq } = history
          yield* SubscriptionRef.update(
            entries,
            (current) =>
              new Map(current).set(paneId, { state, seq, inWorkspace }) as ReadonlyMap<
                PaneId,
                Entry
              >
          )
          return state
        })
      )

    const tabOf = (paneId: PaneId) =>
      Effect.map(SubscriptionRef.get(workspaceFeed), (workspace) => {
        const found = WorkspaceOps.tabOf(workspace, paneId)
        return Result.isSuccess(found) ? found.success.tab : undefined
      })

    const seedFrom = Effect.fn('PaneChatProjection.seed')(function* (
      paneId: PaneId,
      tab: Tab | undefined
    ) {
      if ((yield* SubscriptionRef.get(entries)).has(paneId)) return
      if (tab?.sessionId !== undefined) {
        yield* recorder.catchUp({ agentId: paneId, sessionId: tab.sessionId, cwd: tab.config.cwd })
      }
      const state = yield* insertIfAbsent(paneId, tab !== undefined)
      if (state !== undefined) {
        yield* Effect.logDebug('Seeded pane chat state', {
          paneId,
          messages: state.messages.length,
          inWorkspace: tab !== undefined
        })
      }
    })

    const seed = (paneId: PaneId) => Effect.flatMap(tabOf(paneId), (tab) => seedFrom(paneId, tab))

    const caughtUp = Effect.fn('PaneChatProjection.caughtUp')(function* (
      paneId: PaneId,
      target: number
    ) {
      const reached = yield* SubscriptionRef.changes(entries).pipe(
        Stream.filter((current) => (current.get(paneId)?.seq ?? target) >= target),
        Stream.runHead,
        Effect.timeoutOption(CATCH_UP_LIMIT)
      )
      if (Option.isNone(reached)) {
        yield* Effect.logWarning('Served a pane chat snapshot behind the event stream', {
          paneId,
          target
        })
      }
      return (yield* SubscriptionRef.get(entries)).get(paneId)
    })

    const snapshot = Effect.fn('PaneChatProjection.snapshot')(function* (paneId: PaneId) {
      const tab = yield* tabOf(paneId)
      if (tab !== undefined) yield* seedFrom(paneId, tab)
      const target = yield* store
        .lastSequence(paneId)
        .pipe(
          Effect.catch((error) =>
            Effect.logError('Could not read the last pane event sequence', { paneId, error }).pipe(
              Effect.as(0)
            )
          )
        )
      const entry = yield* caughtUp(paneId, target)
      return entry === undefined
        ? { state: emptyPaneChatState, seq: 0 }
        : { state: entry.state, seq: entry.seq }
    })

    const withDisplayName = (event: PaneStreamEvent) =>
      Effect.gen(function* () {
        if (event._tag !== 'PaneModelChanged') return event
        const catalog = yield* modelCatalog.current
        const option =
          catalog.state._tag === 'Ready'
            ? catalog.state.models.find((candidate) => candidate.value === event.model)
            : undefined
        return option === undefined ? event : { ...event, displayName: option.displayName }
      })

    const foldFrame = (frame: PaneEventFrame) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(entries)).get(frame.paneId)
          if (entry === undefined) {
            yield* Effect.logDebug('Ignored an event for a pane with no chat state', {
              paneId: frame.paneId,
              event: frame.event._tag
            })
            return
          }
          if (frame.seq <= entry.seq) return
          const event: IpcEvent = frame.event
          const state = isPaneStreamEvent(event)
            ? reducePaneChat(
                entry.state,
                yield* withDisplayName(event),
                yield* Clock.currentTimeMillis
              )
            : entry.state
          yield* SubscriptionRef.update(entries, (current) =>
            new Map(current).set(frame.paneId, { ...entry, state, seq: frame.seq })
          )
        })
      )

    const applyWorkspace = lock.withPermits(1)(
      Effect.gen(function* () {
        const tabs = paneIdsOf(yield* SubscriptionRef.get(workspaceFeed))
        const evicted: Array<PaneId> = []
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map<PaneId, Entry>()
          for (const [paneId, entry] of current) {
            if (tabs.has(paneId)) next.set(paneId, { ...entry, inWorkspace: true })
            else if (entry.inWorkspace) evicted.push(paneId)
            else next.set(paneId, entry)
          }
          return next
        })
        if (evicted.length > 0) {
          yield* Effect.logDebug('Dropped the chat state of removed tabs', { panes: evicted })
        }
      })
    )

    const handle = (frame: EventFrame) => {
      if (frame._tag === 'PaneEvent') return foldFrame(frame)
      if (frame._tag === 'GlobalEvent' && frame.event._tag === 'WorkspaceChanged') {
        return applyWorkspace
      }
      return Effect.void
    }

    yield* hub
      .subscribe({})
      .pipe(Stream.runForEach(handle), Effect.forkScoped({ startImmediately: true }))
    yield* Effect.logDebug('Following pane events for chat state')

    return PaneChatProjection.of({ snapshot, seed })
  })
)
