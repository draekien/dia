import {
  type CommittedEvent,
  type HostPluginContext,
  type ModelCatalogState,
  PaneAgentEvent,
  PaneChat
} from '@dia/plugin'
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Semaphore,
  Stream,
  SubscriptionRef
} from 'effect'
import { RunEventRecorder } from './recorder'
import { RunEventStore } from './store'

type Workspace = Stream.Success<HostPluginContext['workspace']>
type Tab = Workspace['projects'][number]['tabs'][number]

/**
 * The workspace as `ctx.workspace` last reported it: the current value, and each change after it.
 * Provide it from the plugin's host entry once the first value arrived.
 */
export class RunWorkspace extends Context.Service<
  RunWorkspace,
  SubscriptionRef.SubscriptionRef<Workspace>
>()('RunWorkspace') {}

/**
 * The model list the loaded agent backend reports now, used to name a changed model. Reads
 * `Loading` when no backend is loaded.
 */
export class RunModelCatalog extends Context.Service<
  RunModelCatalog,
  { readonly current: Effect.Effect<ModelCatalogState> }
>()('RunModelCatalog') {}

/**
 * The chat state of every run that has one, folded from the run's committed events on top of its
 * stored conversation. Read it with `snapshot`; call `seed` before a session for the run starts.
 * Provide it with {@link RunChatProjectionLive}.
 */
export class RunChatProjection extends Context.Service<
  RunChatProjection,
  {
    /**
     * The run's chat state and the sequence of the last event in it. A workspace tab with no state
     * yet is seeded from its stored conversation first. Any other id that was seeded, such as an
     * attached session's, keeps its state; an id never seeded gets the empty state and `seq` 0, and
     * nothing is kept for it.
     */
    readonly snapshot: (runId: string) => Effect.Effect<PaneChat.PaneChatSnapshot>
    /**
     * Gives the run state unless it already has some, built from the run's stored conversation. A
     * workspace tab with a session first imports the turns its transcript holds that are not
     * stored yet (turns added outside dia). A run that is not a workspace tab keeps its state after
     * workspace changes. Call it before a session for the run starts.
     */
    readonly seed: (runId: string) => Effect.Effect<void>
    /**
     * Drops the in-memory state of a run that is not a workspace tab, such as a detached
     * session's. Does nothing for a workspace tab or an id with no state. Deletes no event.
     */
    readonly release: (runId: string) => Effect.Effect<void>
  }
>()('RunChatProjection') {}

interface Entry {
  readonly state: PaneChat.PaneChatState
  readonly seq: number
  readonly inWorkspace: boolean
}

const CATCH_UP_LIMIT = Duration.seconds(2)

const tabIdsOf = (workspace: Workspace): ReadonlySet<string> =>
  new Set(workspace.projects.flatMap((entry) => entry.tabs.map((tab) => tab.config.paneId)))

const findTab = (workspace: Workspace, runId: string): Tab | undefined =>
  workspace.projects
    .flatMap((entry) => entry.tabs)
    .find((candidate) => candidate.config.paneId === runId)

const ipcEventOf = (committed: CommittedEvent) =>
  'paneId' in committed.event
    ? committed.event
    : PaneAgentEvent.make(
        { paneId: committed.runId, agentEvent: committed.event },
        { disableChecks: true }
      )

/**
 * Live {@link RunChatProjection}; follows the store's committed events and the workspace for the
 * layer's lifetime. Requires `RunEventStore`, `RunEventRecorder`, {@link RunWorkspace} and
 * {@link RunModelCatalog}.
 */
export const RunChatProjectionLive = Layer.effect(
  RunChatProjection,
  Effect.gen(function* () {
    const workspaceRef = yield* RunWorkspace
    const store = yield* RunEventStore
    const recorder = yield* RunEventRecorder
    const modelCatalog = yield* RunModelCatalog
    const entries = yield* SubscriptionRef.make<ReadonlyMap<string, Entry>>(new Map())
    const lock = yield* Semaphore.make(1)

    const storedHistory = (runId: string) =>
      store.readHistory(runId).pipe(
        Effect.map(({ items, through }) => ({
          state: PaneChat.paneChatStateFromItems(items),
          seq: through
        })),
        Effect.catch((error) =>
          Effect.logError('Could not read run history; serving it empty until a read succeeds', {
            runId,
            error
          }).pipe(Effect.as(undefined))
        )
      )

    const insertIfAbsent = (runId: string, inWorkspace: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(entries)).has(runId)) return undefined
          const history = yield* storedHistory(runId)
          if (history === undefined) return undefined
          const { state, seq } = history
          yield* SubscriptionRef.update(entries, (current) =>
            new Map(current).set(runId, { state, seq, inWorkspace })
          )
          return state
        })
      )

    const tabOf = (runId: string) =>
      Effect.map(SubscriptionRef.get(workspaceRef), (workspace) => findTab(workspace, runId))

    const seedFrom = Effect.fn('RunChatProjection.seed')(function* (
      runId: string,
      tab: Tab | undefined
    ) {
      if ((yield* SubscriptionRef.get(entries)).has(runId)) return
      if (tab?.sessionId !== undefined) {
        yield* recorder.catchUp({ runId, sessionId: tab.sessionId, cwd: tab.config.cwd })
      }
      const state = yield* insertIfAbsent(runId, tab !== undefined)
      if (state !== undefined) {
        yield* Effect.logDebug('Seeded run chat state', {
          runId,
          messages: state.messages.length,
          inWorkspace: tab !== undefined
        })
      }
    })

    const seed = (runId: string) => Effect.flatMap(tabOf(runId), (tab) => seedFrom(runId, tab))

    const caughtUp = Effect.fn('RunChatProjection.caughtUp')(function* (
      runId: string,
      target: number
    ) {
      const reached = yield* SubscriptionRef.changes(entries).pipe(
        Stream.filter((current) => (current.get(runId)?.seq ?? target) >= target),
        Stream.runHead,
        Effect.timeoutOption(CATCH_UP_LIMIT)
      )
      if (Option.isNone(reached)) {
        yield* Effect.logWarning('Served a run chat snapshot behind the event log', {
          runId,
          target
        })
      }
      return (yield* SubscriptionRef.get(entries)).get(runId)
    })

    const snapshot = Effect.fn('RunChatProjection.snapshot')(function* (runId: string) {
      const tab = yield* tabOf(runId)
      if (tab !== undefined) yield* seedFrom(runId, tab)
      const target = yield* store
        .lastSequence(runId)
        .pipe(
          Effect.catch((error) =>
            Effect.logError('Could not read the last run event sequence', { runId, error }).pipe(
              Effect.as(0)
            )
          )
        )
      const entry = yield* caughtUp(runId, target)
      return entry === undefined
        ? { state: PaneChat.emptyPaneChatState, seq: 0 }
        : { state: entry.state, seq: entry.seq }
    })

    const withDisplayName = (event: PaneChat.PaneStreamEvent) =>
      Effect.gen(function* () {
        if (event._tag !== 'PaneModelChanged') return event
        const catalog = yield* modelCatalog.current
        const option =
          catalog._tag === 'Ready'
            ? catalog.models.find((candidate) => candidate.value === event.model)
            : undefined
        return option === undefined ? event : { ...event, displayName: option.displayName }
      })

    const fold = (committed: CommittedEvent) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(entries)).get(committed.runId)
          if (entry === undefined || committed.sequence <= entry.seq) return
          const event = ipcEventOf(committed)
          const state = PaneChat.isPaneStreamEvent(event)
            ? PaneChat.reducePaneChat(
                entry.state,
                yield* withDisplayName(event),
                yield* Clock.currentTimeMillis
              )
            : entry.state
          yield* SubscriptionRef.update(entries, (current) =>
            new Map(current).set(committed.runId, { ...entry, state, seq: committed.sequence })
          )
        })
      )

    const applyWorkspace = (workspace: Workspace) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const tabs = tabIdsOf(workspace)
          const evicted: Array<string> = []
          yield* SubscriptionRef.update(entries, (current) => {
            const next = new Map<string, Entry>()
            for (const [runId, entry] of current) {
              if (tabs.has(runId)) next.set(runId, { ...entry, inWorkspace: true })
              else if (entry.inWorkspace) evicted.push(runId)
              else next.set(runId, entry)
            }
            return next
          })
          if (evicted.length > 0) {
            yield* Effect.logDebug('Dropped the chat state of removed tabs; their events stay', {
              runs: evicted
            })
          }
        })
      )

    const release = Effect.fn('RunChatProjection.release')(function* (runId: string) {
      const released = yield* lock.withPermits(1)(
        SubscriptionRef.modify(entries, (current) => {
          const entry = current.get(runId)
          if (entry === undefined || entry.inWorkspace) return [false, current] as const
          const next = new Map(current)
          next.delete(runId)
          return [true, next] as const
        })
      )
      if (released) yield* Effect.logDebug('Released the chat state of a detached run', { runId })
    })

    yield* store.committed.pipe(
      Stream.runForEach(fold),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* SubscriptionRef.changes(workspaceRef).pipe(
      Stream.runForEach(applyWorkspace),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* Effect.logDebug('Following run events for chat state')

    return RunChatProjection.of({ snapshot, seed, release })
  })
)
