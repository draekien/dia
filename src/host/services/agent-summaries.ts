import {
  type AgentSummary,
  foldSummary,
  idleSummary,
  markShown,
  NoActivity
} from '@shared/domain/agent-summary'
import type { PaneId } from '@shared/domain/pane'
import type { Workspace } from '@shared/domain/project'
import { AgentSummaryChanged, type IpcEvent } from '@shared/ipc/contract'
import type { EventFrame } from '@shared/ipc/rpc'
import { Context, Duration, Effect, Equal, Fiber, Layer, Ref, Stream } from 'effect'
import { EventHub } from './event-hub'
import { PaneWorkspace } from './pane-workspace'
import { type PersistedActivity, PersistenceService } from './persistence'

/** How long after an activity line changes it is written to disk. */
export const ACTIVITY_SAVE_DELAY = Duration.seconds(2)

/**
 * The current {@link AgentSummary} of every tab: its overview status and activity line, folded
 * from the Host's pane events. Publishes `AgentSummaryChanged` on the {@link EventHub} whenever a
 * summary changes; read all summaries with `getAll` when a client connects. A finished tab that
 * is the visible tab becomes idle at once. Activity lines survive a restart; statuses start idle.
 */
export class AgentSummaries extends Context.Service<
  AgentSummaries,
  {
    readonly getAll: Effect.Effect<ReadonlyArray<AgentSummary>>
  }
>()('AgentSummaries') {}

interface State {
  readonly summaries: ReadonlyMap<PaneId, AgentSummary>
  readonly visibleTab: PaneId | null
}

const tabIdsOf = (workspace: Workspace): ReadonlySet<PaneId> =>
  new Set(workspace.projects.flatMap((entry) => entry.tabs.map((tab) => tab.config.paneId)))

const paneIdOf = (event: IpcEvent): PaneId | undefined =>
  'paneId' in event && typeof event.paneId === 'string' ? event.paneId : undefined

const shownIfVisible = (summary: AgentSummary, visibleTab: PaneId | null): AgentSummary =>
  visibleTab === summary.paneId ? markShown(summary) : summary

/**
 * Builds the live {@link AgentSummaries} layer. It seeds one idle summary per tab with the
 * activity line saved at `<userData>/activity.json`, then follows the {@link EventHub} for the
 * lifetime of the layer's scope, saving activity lines {@link ACTIVITY_SAVE_DELAY} after they
 * change and once more when the scope closes. Requires {@link EventHub},
 * {@link PersistenceService} and {@link PaneWorkspace}.
 */
export const AgentSummariesLive = Layer.effect(
  AgentSummaries,
  Effect.gen(function* () {
    const hub = yield* EventHub
    const persistence = yield* PersistenceService
    const workspace = yield* (yield* PaneWorkspace).getWorkspace
    const saved = yield* persistence.loadActivity

    const seeded = new Map<PaneId, AgentSummary>()
    for (const paneId of tabIdsOf(workspace)) {
      seeded.set(paneId, idleSummary(paneId, saved[paneId] ?? NoActivity.make({})))
    }
    const stateRef = yield* Ref.make<State>({
      summaries: seeded,
      visibleTab: workspace.visibleTab
    })
    const savePending = yield* Ref.make(false)

    const flush = Effect.gen(function* () {
      yield* Ref.set(savePending, false)
      const { summaries } = yield* Ref.get(stateRef)
      const activity: PersistedActivity = Object.fromEntries(
        [...summaries.values()].map((summary) => [summary.paneId, summary.activity])
      )
      yield* persistence
        .saveActivity(activity)
        .pipe(Effect.catch((cause) => Effect.logError('Failed to persist activity', { cause })))
    }).pipe(Effect.withSpan('AgentSummaries.flush'))

    const scheduleSave = Effect.gen(function* () {
      const alreadyPending = yield* Ref.getAndSet(savePending, true)
      if (alreadyPending) return
      yield* Effect.sleep(ACTIVITY_SAVE_DELAY).pipe(Effect.andThen(flush), Effect.forkScoped)
    })

    const publishChanges = Effect.fn('AgentSummaries.publishChanges')(function* (
      before: ReadonlyMap<PaneId, AgentSummary>,
      after: ReadonlyMap<PaneId, AgentSummary>
    ) {
      let activityChanged = false
      for (const [paneId, summary] of after) {
        const previous = before.get(paneId)
        if (previous !== undefined && Equal.equals(previous, summary)) continue
        if (previous === undefined || !Equal.equals(previous.activity, summary.activity)) {
          activityChanged = true
        }
        yield* hub.publish(AgentSummaryChanged.make({ summary }))
      }
      if (activityChanged || [...before.keys()].some((paneId) => !after.has(paneId))) {
        yield* scheduleSave
      }
    })

    const applyWorkspace = (state: State, next: Workspace): State => {
      const tabIds = tabIdsOf(next)
      const summaries = new Map<PaneId, AgentSummary>()
      for (const paneId of tabIds) {
        const summary = state.summaries.get(paneId) ?? idleSummary(paneId, NoActivity.make({}))
        summaries.set(paneId, shownIfVisible(summary, next.visibleTab))
      }
      return { summaries, visibleTab: next.visibleTab }
    }

    const applyPaneEvent = (state: State, paneId: PaneId, event: IpcEvent): State => {
      const current = state.summaries.get(paneId) ?? idleSummary(paneId, NoActivity.make({}))
      const next = shownIfVisible(foldSummary(current, event), state.visibleTab)
      if (next === current && state.summaries.has(paneId)) return state
      return { ...state, summaries: new Map(state.summaries).set(paneId, next) }
    }

    const handle = Effect.fn('AgentSummaries.handle')(function* (frame: EventFrame) {
      if (frame._tag === 'ReloadHistory') return
      const event = frame.event
      if (event._tag === 'AgentSummaryChanged' || event._tag === 'AgentSummariesReplaced') return
      const before = yield* Ref.get(stateRef)
      const paneId = paneIdOf(event)
      const after =
        event._tag === 'WorkspaceChanged'
          ? applyWorkspace(before, event.workspace)
          : paneId === undefined
            ? before
            : applyPaneEvent(before, paneId, event)
      if (after === before) return
      yield* Ref.set(stateRef, after)
      yield* publishChanges(before.summaries, after.summaries)
    })

    const follower = yield* hub
      .subscribe({})
      .pipe(Stream.runForEach(handle), Effect.forkScoped({ startImmediately: true }))
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(follower).pipe(
        Effect.andThen(Ref.get(savePending)),
        Effect.flatMap((pending) => (pending ? flush : Effect.void))
      )
    )
    yield* Effect.logDebug('Following pane events for agent summaries', { tabs: seeded.size })

    return {
      getAll: Effect.map(Ref.get(stateRef), (state) => [...state.summaries.values()])
    }
  })
)
