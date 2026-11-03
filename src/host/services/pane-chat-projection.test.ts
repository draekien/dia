import { assert, describe, it } from '@effect/vitest'
import { Errored, Idle } from '@shared/domain/attention'
import { ModelsReady } from '@shared/domain/model'
import { SessionId } from '@shared/domain/pane'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import {
  type IpcEvent,
  PaneAssistantTextDelta,
  PaneAttentionChanged,
  PaneModelChanged,
  WorkspaceChanged
} from '@shared/ipc/contract'
import { DateTime, Deferred, Effect, Fiber, Layer, SubscriptionRef } from 'effect'
import { EventHub, makeEventHubLive } from './event-hub'
import { ModelCatalogFeed } from './model-catalog-feed'
import { PaneChatProjection, PaneChatProjectionLive } from './pane-chat-projection'
import { TranscriptReader } from './transcript-reader'
import { WorkspaceFeed, WorkspaceFeedLive } from './workspace-feed'

const PANE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const PANE_B = 'bbbbbbbb-0000-4000-8000-000000000002'

const tab = (paneId: string, sessionId?: string): Tab => ({
  name: AgentName.make('heron'),
  config: {
    paneId,
    cwd: '/repo',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived: false,
  ...(sessionId === undefined ? {} : { sessionId: SessionId.make(sessionId) })
})

const workspaceOf = (tabs: ReadonlyArray<Tab>): Workspace => ({
  projects: [
    {
      project: {
        projectId: ProjectId.make('11111111-0000-4000-8000-000000000001'),
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'repo',
        isGitRepo: true
      },
      tabs: [...tabs]
    }
  ],
  visibleTab: null
})

const CATALOG = {
  revision: 1,
  state: ModelsReady.make({
    models: [
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Everyday tasks',
        adaptiveThinking: true,
        effortLevels: ['low'],
        autoMode: true,
        fastMode: false
      }
    ],
    fetchedAt: DateTime.makeUnsafe('2026-10-25T15:00:00Z'),
    refreshing: false
  })
}

const makeSetup = (catalogReady: Effect.Effect<void> = Effect.void) => {
  const reads: Array<string> = []
  const transcripts = Layer.succeed(TranscriptReader, {
    readHistory: (sessionId) =>
      Effect.sync(() => {
        reads.push(sessionId)
        return [{ role: 'user' as const, content: `from ${sessionId}` }]
      }),
    discoverSessions: () => Effect.succeed([]),
    readTranscriptAfter: () => Effect.die('not called')
  })
  const models = Layer.succeed(ModelCatalogFeed, {
    start: Effect.void,
    current: Effect.as(catalogReady, CATALOG),
    refresh: Effect.void
  })
  const layer = Layer.provideMerge(
    PaneChatProjectionLive,
    Layer.mergeAll(makeEventHubLive(), WorkspaceFeedLive, transcripts, models)
  )
  return { reads, layer }
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const publish = (event: IpcEvent) =>
  Effect.flatMap(EventHub, (hub) => hub.publish(event)).pipe(Effect.andThen(settle))

const setWorkspace = (workspace: Workspace) =>
  Effect.gen(function* () {
    yield* SubscriptionRef.set(yield* WorkspaceFeed, workspace)
    yield* publish(WorkspaceChanged.make({ workspace }))
  })

const snapshotOf = (paneId: string) =>
  Effect.flatMap(PaneChatProjection, (projection) => projection.snapshot(paneId))

const seed = (paneId: string) =>
  Effect.flatMap(PaneChatProjection, (projection) => projection.seed(paneId))

const textsOf = (paneId: string) =>
  Effect.map(snapshotOf(paneId), ({ state }) =>
    state.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'text' ? [part.content] : []))
    )
  )

const delta = (paneId: string, text: string) => PaneAssistantTextDelta.make({ paneId, text })

describe('PaneChatProjection', () => {
  it.effect('serves a tab with a session from its transcript at sequence 0', () => {
    const { reads, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))

      const snapshot = yield* snapshotOf(PANE_A)

      assert.strictEqual(snapshot.seq, 0)
      assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1'])
      assert.deepStrictEqual(reads, ['s-1'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('serves a tab with no session as an empty conversation without reading', () => {
    const { reads, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))

      assert.deepStrictEqual(yield* textsOf(PANE_A), [])
      assert.deepStrictEqual(reads, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'folds every later pane event onto the tab and reports the last sequence number',
    () => {
      const { layer } = makeSetup()
      return Effect.gen(function* () {
        yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
        yield* seed(PANE_A)

        yield* publish(delta(PANE_A, 'hi'))
        yield* publish(delta(PANE_A, ' there'))

        assert.strictEqual((yield* snapshotOf(PANE_A)).seq, 2)
        assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1', 'hi there'])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect('keeps the attention a tab reports', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_A)
      const errored = Errored.make({ error: { message: 'boom' } })

      yield* publish(PaneAttentionChanged.make({ paneId: PANE_A, attention: errored }))

      assert.deepStrictEqual((yield* snapshotOf(PANE_A)).state.attention, errored)
    }).pipe(Effect.provide(layer))
  })

  it.effect('names a changed model by its catalog display name', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_A)

      yield* publish(PaneModelChanged.make({ paneId: PANE_A, model: 'sonnet' }))

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['Model → Sonnet'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('ignores events for a tab published before it was seeded', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))

      yield* publish(delta(PANE_A, 'lost'))
      yield* seed(PANE_A)
      yield* publish(delta(PANE_A, 'kept'))

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['kept'])
      assert.strictEqual((yield* snapshotOf(PANE_A)).seq, 2)
    }).pipe(Effect.provide(layer))
  })

  it.effect('keeps the state it holds when seeded again', () => {
    const { reads, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
      yield* seed(PANE_A)
      yield* publish(delta(PANE_A, 'hi'))

      yield* seed(PANE_A)

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1', 'hi'])
      assert.deepStrictEqual(reads, ['s-1'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('serves an id that is not a tab as empty and keeps nothing for it', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))

      const snapshot = yield* snapshotOf(PANE_B)
      yield* publish(delta(PANE_B, 'stray'))

      assert.deepStrictEqual(snapshot, yield* snapshotOf(PANE_B))
      assert.deepStrictEqual(snapshot.state.attention, Idle.make({}))
      assert.strictEqual(snapshot.seq, 0)
    }).pipe(Effect.provide(layer))
  })

  it.effect('follows a tab seeded before it joins the workspace', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_B)
      yield* publish(delta(PANE_B, 'setting up'))

      yield* setWorkspace(workspaceOf([tab(PANE_A), tab(PANE_B)]))

      assert.deepStrictEqual(yield* textsOf(PANE_B), ['setting up'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('waits for an event still being folded before serving the snapshot', () => {
    const catalogReady = Deferred.makeUnsafe<void>()
    const { layer } = makeSetup(Deferred.await(catalogReady))
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_A)
      yield* publish(PaneModelChanged.make({ paneId: PANE_A, model: 'sonnet' }))

      const pending = yield* Effect.forkChild(snapshotOf(PANE_A))
      yield* settle
      yield* Deferred.succeed(catalogReady, undefined)
      const snapshot = yield* Fiber.join(pending)

      assert.strictEqual(snapshot.seq, 1)
      assert.deepStrictEqual(yield* textsOf(PANE_A), ['Model → Sonnet'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('numbers a seeded tab after the events published before it was seeded', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* publish(delta(PANE_A, 'before'))
      yield* publish(delta(PANE_A, 'seeding'))

      const snapshot = yield* snapshotOf(PANE_A)

      assert.strictEqual(snapshot.seq, 2)
      assert.deepStrictEqual(yield* textsOf(PANE_A), [])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'keeps a tab that a stale workspace event leaves out but the workspace still has',
    () => {
      const { layer } = makeSetup()
      return Effect.gen(function* () {
        yield* setWorkspace(workspaceOf([tab(PANE_A)]))
        yield* seed(PANE_A)
        yield* publish(delta(PANE_A, 'hi'))

        yield* publish(WorkspaceChanged.make({ workspace: workspaceOf([]) }))

        assert.deepStrictEqual(yield* textsOf(PANE_A), ['hi'])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect('drops the state of a tab that leaves the workspace', () => {
    const { reads, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
      yield* seed(PANE_A)
      yield* publish(delta(PANE_A, 'hi'))

      yield* setWorkspace(workspaceOf([]))
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1'])
      assert.deepStrictEqual(reads, ['s-1', 's-1'])
    }).pipe(Effect.provide(layer))
  })
})
