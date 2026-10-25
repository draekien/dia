import { assert, describe, it } from '@effect/vitest'
import {
  type AgentSummary,
  NoActivity,
  StatusFinished,
  StatusIdle,
  Todo,
  ToolUse
} from '@shared/domain/agent-summary'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import { type IpcEvent, WorkspaceChanged } from '@shared/ipc/contract'
import { Duration, Effect, Exit, Layer, Option, Scope, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { ACTIVITY_SAVE_DELAY, AgentSummaries, AgentSummariesLive } from './agent-summaries'
import { EventHub, makeEventHubLive } from './event-hub'
import { PaneWorkspace } from './pane-workspace'
import { type PersistedActivity, PersistenceService } from './persistence'

const PANE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const PANE_B = 'bbbbbbbb-0000-4000-8000-000000000002'

const tab = (paneId: string): Tab => ({
  name: AgentName.make('heron'),
  config: {
    paneId,
    cwd: '/repo',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived: false
})

const workspaceWith = (paneIds: ReadonlyArray<string>, visible?: string): Workspace => ({
  projects: [
    {
      project: {
        projectId: ProjectId.make('11111111-0000-4000-8000-000000000001'),
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'repo',
        isGitRepo: true
      },
      tabs: paneIds.map(tab)
    }
  ],
  visibleTab: visible ?? null
})

const makeSetup = (initial: Workspace, saved: PersistedActivity = {}) => {
  const saves: Array<PersistedActivity> = []
  const persistence = Layer.succeed(PersistenceService, {
    loadWorkspace: Effect.succeed(Option.none()),
    saveWorkspace: () => Effect.void,
    loadActivity: Effect.succeed(saved),
    saveActivity: (activity) => Effect.sync(() => void saves.push(activity))
  })
  const workspace = Layer.succeed(PaneWorkspace, {
    getWorkspace: Effect.succeed(initial)
  } as unknown as PaneWorkspace['Service'])
  const layer = Layer.provideMerge(
    AgentSummariesLive,
    Layer.mergeAll(makeEventHubLive(), persistence, workspace)
  )
  return { saves, layer }
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const publish = (event: IpcEvent) =>
  Effect.flatMap(EventHub, (hub) => hub.publish(event)).pipe(Effect.andThen(settle))

const summaryOf = (paneId: string) =>
  Effect.map(
    Effect.flatMap(AgentSummaries, (service) => service.getAll),
    (all) => all.find((summary) => summary.paneId === paneId)
  )

const recordChanges = Effect.gen(function* () {
  const changes: Array<AgentSummary> = []
  const hub = yield* EventHub
  yield* hub.subscribe({}).pipe(
    Stream.runForEach((frame) =>
      Effect.sync(() => {
        if (frame._tag === 'GlobalEvent' && frame.event._tag === 'AgentSummaryChanged') {
          changes.push(frame.event.summary)
        }
      })
    ),
    Effect.forkScoped
  )
  yield* settle
  return changes
})

const toolCompleted = (paneId: string, file: string): IpcEvent => ({
  _tag: 'PaneToolCallCompleted',
  paneId,
  toolCallId: 'c',
  toolName: 'Edit',
  input: { file_path: file },
  output: '',
  isError: false
})

const completed = (paneId: string): IpcEvent => ({
  _tag: 'PaneAttentionChanged',
  paneId,
  attention: { _tag: 'Completed' }
})

describe('AgentSummaries', () => {
  it.effect('seeds every tab as idle with its saved activity line', () =>
    Effect.gen(function* () {
      const saved = { [PANE_A]: Todo.make({ text: 'Fixing the bug' }) }
      const { layer } = makeSetup(workspaceWith([PANE_A, PANE_B]), saved)

      const [a, b] = yield* Effect.all([summaryOf(PANE_A), summaryOf(PANE_B)]).pipe(
        Effect.provide(layer)
      )

      assert.deepStrictEqual(a, {
        paneId: PANE_A,
        status: StatusIdle.make({}),
        activity: Todo.make({ text: 'Fixing the bug' })
      })
      assert.deepStrictEqual(b, {
        paneId: PANE_B,
        status: StatusIdle.make({}),
        activity: NoActivity.make({})
      })
    })
  )

  it.effect('folds a pane event into the summary and publishes the change', () =>
    Effect.gen(function* () {
      const { layer } = makeSetup(workspaceWith([PANE_A]))

      const [summary, changes] = yield* Effect.gen(function* () {
        const changes = yield* recordChanges
        yield* publish(toolCompleted(PANE_A, 'src/app.tsx'))
        return [yield* summaryOf(PANE_A), changes] as const
      }).pipe(Effect.scoped, Effect.provide(layer))

      const expected = ToolUse.make({ tool: 'Edit', target: 'src/app.tsx' })
      assert.deepStrictEqual(summary?.activity, expected)
      assert.deepStrictEqual(
        changes.map((change) => change.activity),
        [expected]
      )
    })
  )

  it.effect('marks a tab that is not shown finished when its turn completes', () =>
    Effect.gen(function* () {
      const { layer } = makeSetup(workspaceWith([PANE_A, PANE_B], PANE_B))

      const summary = yield* publish(completed(PANE_A)).pipe(
        Effect.andThen(summaryOf(PANE_A)),
        Effect.provide(layer)
      )

      assert.deepStrictEqual(summary?.status, StatusFinished.make({}))
    })
  )

  it.effect('keeps the shown tab idle when its turn completes', () =>
    Effect.gen(function* () {
      const { layer } = makeSetup(workspaceWith([PANE_A], PANE_A))

      const summary = yield* publish(completed(PANE_A)).pipe(
        Effect.andThen(summaryOf(PANE_A)),
        Effect.provide(layer)
      )

      assert.deepStrictEqual(summary?.status, StatusIdle.make({}))
    })
  )

  it.effect('turns a finished tab idle once the workspace shows it', () =>
    Effect.gen(function* () {
      const { layer } = makeSetup(workspaceWith([PANE_A, PANE_B], PANE_B))

      const summary = yield* Effect.gen(function* () {
        yield* publish(completed(PANE_A))
        yield* publish(
          WorkspaceChanged.make({ workspace: workspaceWith([PANE_A, PANE_B], PANE_A) })
        )
        return yield* summaryOf(PANE_A)
      }).pipe(Effect.provide(layer))

      assert.deepStrictEqual(summary?.status, StatusIdle.make({}))
    })
  )

  it.effect('drops the summary of a tab the workspace no longer has', () =>
    Effect.gen(function* () {
      const { layer } = makeSetup(workspaceWith([PANE_A, PANE_B], PANE_A))

      const summary = yield* publish(
        WorkspaceChanged.make({ workspace: workspaceWith([PANE_A], PANE_A) })
      ).pipe(Effect.andThen(summaryOf(PANE_B)), Effect.provide(layer))

      assert.isUndefined(summary)
    })
  )

  it.effect('saves activity lines only once the save delay has passed', () =>
    Effect.gen(function* () {
      const { layer, saves } = makeSetup(workspaceWith([PANE_A]))

      const [before, after] = yield* Effect.gen(function* () {
        yield* publish(toolCompleted(PANE_A, 'a.ts'))
        yield* TestClock.adjust(Duration.subtract(ACTIVITY_SAVE_DELAY, Duration.millis(1)))
        const before = saves.length
        yield* TestClock.adjust(Duration.millis(1))
        yield* settle
        return [before, saves.length] as const
      }).pipe(Effect.provide(layer))

      assert.strictEqual(before, 0)
      assert.strictEqual(after, 1)
      assert.deepStrictEqual(saves[0], {
        [PANE_A]: ToolUse.make({ tool: 'Edit', target: 'a.ts' })
      })
    })
  )

  it.effect('saves pending activity lines when the service shuts down', () =>
    Effect.gen(function* () {
      const { layer, saves } = makeSetup(workspaceWith([PANE_A]))
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(layer, scope)

      yield* publish(toolCompleted(PANE_A, 'a.ts')).pipe(Effect.provideContext(context))
      yield* Scope.close(scope, Exit.void)

      assert.strictEqual(saves.length, 1)
    })
  )
})
