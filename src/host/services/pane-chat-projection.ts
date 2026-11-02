import type { PaneId } from '@shared/domain/pane'
import {
  emptyPaneChatState,
  isPaneStreamEvent,
  type PaneChatSnapshot,
  type PaneChatState,
  type PaneStreamEvent,
  paneChatStateFromHistory,
  reducePaneChat
} from '@shared/domain/pane-chat'
import type { Workspace } from '@shared/domain/project'
import * as WorkspaceOps from '@shared/domain/workspace'
import type { IpcEvent } from '@shared/ipc/contract'
import type { EventFrame, PaneEventFrame } from '@shared/ipc/rpc'
import {
  Clock,
  Context,
  Effect,
  Layer,
  Ref,
  Result,
  Semaphore,
  Stream,
  SubscriptionRef
} from 'effect'
import { EventHub } from './event-hub'
import { ModelCatalogFeed } from './model-catalog-feed'
import { TranscriptReader } from './transcript-reader'
import { WorkspaceFeed } from './workspace-feed'

/**
 * The chat state of every workspace tab, folded from the Host's pane events on top of the tab's
 * transcript. Read a tab's state with `snapshot`. Call `seed` before starting a session for a
 * tab. Provide it with {@link PaneChatProjectionLive}.
 */
export class PaneChatProjection extends Context.Service<
  PaneChatProjection,
  {
    /**
     * The tab's chat state and the sequence number of the last event in it. A workspace tab with
     * no state yet is seeded from its transcript first; an id that is not a workspace tab gets
     * the empty state and `seq` 0, and nothing is kept for it.
     */
    readonly snapshot: (paneId: PaneId) => Effect.Effect<PaneChatSnapshot>
    /**
     * Gives the pane state unless it already has some: a workspace tab with a session starts from
     * its transcript, any other pane (including one `createTab` is about to add) from the empty
     * state. Call it before a session for the pane starts, so the transcript it reads holds no
     * turn the session's events will also add.
     */
    readonly seed: (paneId: PaneId) => Effect.Effect<void>
  }
>()('PaneChatProjection') {}

interface Entry {
  readonly state: PaneChatState
  readonly seq: number
  readonly inWorkspace: boolean
}

const paneIdsOf = (workspace: Workspace): ReadonlySet<PaneId> =>
  new Set(workspace.projects.flatMap((entry) => entry.tabs.map((tab) => tab.config.paneId)))

/** Live {@link PaneChatProjection}; follows the `EventHub` for the layer's lifetime. */
export const PaneChatProjectionLive = Layer.effect(
  PaneChatProjection,
  Effect.gen(function* () {
    const hub = yield* EventHub
    const workspaceFeed = yield* WorkspaceFeed
    const transcriptReader = yield* TranscriptReader
    const modelCatalog = yield* ModelCatalogFeed
    const entries = yield* Ref.make<ReadonlyMap<PaneId, Entry>>(new Map())
    const lock = yield* Semaphore.make(1)

    const insertIfAbsent = (paneId: PaneId, entry: Entry) =>
      lock.withPermits(1)(
        Ref.modify(entries, (current) =>
          current.has(paneId)
            ? [false, current]
            : [true, new Map(current).set(paneId, entry) as ReadonlyMap<PaneId, Entry>]
        )
      )

    const seed = Effect.fn('PaneChatProjection.seed')(function* (paneId: PaneId) {
      if ((yield* Ref.get(entries)).has(paneId)) return
      const found = WorkspaceOps.tabOf(yield* SubscriptionRef.get(workspaceFeed), paneId)
      const tab = Result.isSuccess(found) ? found.success.tab : undefined
      const state =
        tab?.sessionId === undefined
          ? emptyPaneChatState
          : paneChatStateFromHistory(
              paneId,
              yield* transcriptReader.readHistory(tab.sessionId, tab.config.cwd)
            )
      const inserted = yield* insertIfAbsent(paneId, {
        state,
        seq: 0,
        inWorkspace: tab !== undefined
      })
      if (inserted) {
        yield* Effect.logDebug('Seeded pane chat state', {
          paneId,
          messages: state.messages.length,
          inWorkspace: tab !== undefined
        })
      }
    })

    const snapshot = Effect.fn('PaneChatProjection.snapshot')(function* (paneId: PaneId) {
      const isTab = Result.isSuccess(
        WorkspaceOps.tabOf(yield* SubscriptionRef.get(workspaceFeed), paneId)
      )
      if (isTab) yield* seed(paneId)
      const entry = (yield* Ref.get(entries)).get(paneId)
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
          const entry = (yield* Ref.get(entries)).get(frame.paneId)
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
          yield* Ref.update(entries, (current) =>
            new Map(current).set(frame.paneId, { ...entry, state, seq: frame.seq })
          )
        })
      )

    const applyWorkspace = (workspace: Workspace) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const tabs = paneIdsOf(workspace)
          const evicted: Array<PaneId> = []
          yield* Ref.update(entries, (current) => {
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
        return applyWorkspace(frame.event.workspace)
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
