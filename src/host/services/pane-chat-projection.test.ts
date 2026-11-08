import { assert, describe, it } from '@effect/vitest'
import { MessageUpdated, ToolCallCompleted, ToolCallStarted } from '@shared/domain/agent-event'
import { Errored, Idle } from '@shared/domain/attention'
import { ModelsReady } from '@shared/domain/model'
import { SessionId } from '@shared/domain/pane'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import {
  type IpcEvent,
  PaneAttentionChanged,
  PaneModelChanged,
  WorkspaceChanged
} from '@shared/ipc/contract'
import { DateTime, Deferred, Effect, Fiber, Layer, Option, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import { AgentEventRecorder } from './agent-event-recorder'
import { AgentEventStore } from './agent-event-store'
import { EventHub } from './event-hub'
import { EventHubTestLayer } from './event-hub-test-layer'
import { ModelCatalogFeed } from './model-catalog-feed'
import { PaneChatProjection, PaneChatProjectionLive } from './pane-chat-projection'
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

const turnFromTranscript = (sessionId: string) =>
  MessageUpdated.make({
    itemId: `transcript-${sessionId}`,
    message: { role: 'user', content: `from ${sessionId}` },
    streaming: false
  })

interface SetupOptions {
  readonly catalogReady?: Effect.Effect<void>
  readonly catchUpGate?: Effect.Effect<void>
}

const makeSetup = ({
  catalogReady = Effect.void,
  catchUpGate = Effect.void
}: SetupOptions = {}) => {
  const catchUps: Array<string> = []
  const recorder = Layer.effect(
    AgentEventRecorder,
    Effect.gen(function* () {
      const store = yield* AgentEventStore
      return AgentEventRecorder.of({
        open: () => Effect.die('not called'),
        catchUp: ({ agentId, sessionId }) =>
          Effect.gen(function* () {
            catchUps.push(sessionId)
            yield* catchUpGate
            yield* store.append(agentId, [
              { event: turnFromTranscript(sessionId), sourceUuid: `${sessionId}-turn` }
            ])
            return Option.some(sessionId)
          }).pipe(Effect.orDie)
      })
    })
  )
  const models = Layer.succeed(ModelCatalogFeed, {
    start: Effect.void,
    current: Effect.as(catalogReady, CATALOG),
    refresh: Effect.void
  })
  const layer = Layer.provideMerge(
    PaneChatProjectionLive,
    Layer.mergeAll(WorkspaceFeedLive, models, recorder).pipe(Layer.provideMerge(EventHubTestLayer))
  )
  return { catchUps, layer }
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const publish = (event: IpcEvent) =>
  Effect.flatMap(EventHub, (hub) => hub.publish(event)).pipe(Effect.andThen(settle))

const reply = (paneId: string, itemId: string, content: string) =>
  Effect.gen(function* () {
    const store = yield* AgentEventStore
    yield* store.append(paneId, [
      {
        event: MessageUpdated.make({
          itemId,
          message: { role: 'assistant', content },
          streaming: false
        })
      }
    ])
    yield* settle
  })

const lastSequence = (paneId: string) =>
  Effect.flatMap(AgentEventStore, (store) => store.lastSequence(paneId))

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

describe('PaneChatProjection', () => {
  it.effect('serves a tab with a session from its caught-up stored conversation', () => {
    const { catchUps, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))

      const snapshot = yield* snapshotOf(PANE_A)

      assert.strictEqual(snapshot.seq, yield* lastSequence(PANE_A))
      assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1'])
      assert.deepStrictEqual(catchUps, ['s-1'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('serves a tab with no session as an empty conversation without catching up', () => {
    const { catchUps, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))

      assert.deepStrictEqual(yield* textsOf(PANE_A), [])
      assert.deepStrictEqual(catchUps, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect('folds every later stored event onto the tab and reports its sequence', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
      yield* seed(PANE_A)

      yield* reply(PANE_A, 'r1', 'hi')
      yield* reply(PANE_A, 'r1', 'hi there')

      assert.strictEqual((yield* snapshotOf(PANE_A)).seq, yield* lastSequence(PANE_A))
      assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1', 'hi there'])
    }).pipe(Effect.provide(layer))
  })

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

  it.effect('seeds a tab with the items stored before it was seeded, once each', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* reply(PANE_A, 'r1', 'stored earlier')

      yield* seed(PANE_A)
      yield* reply(PANE_A, 'r2', 'after seeding')

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['stored earlier', 'after seeding'])
      assert.strictEqual((yield* snapshotOf(PANE_A)).seq, yield* lastSequence(PANE_A))
    }).pipe(Effect.provide(layer))
  })

  it.effect('serves the tool calls stored before the tab was seeded as finished rows', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      const store = yield* AgentEventStore
      yield* store.append(PANE_A, [
        { event: ToolCallStarted.make({ toolCallId: 'call-1', toolName: 'Bash' }) },
        {
          event: ToolCallCompleted.make({
            toolCallId: 'call-1',
            toolName: 'Bash',
            input: { command: 'ls' },
            output: 'a.ts',
            isError: false
          })
        }
      ])

      const { state } = yield* snapshotOf(PANE_A)

      assert.deepStrictEqual(
        state.messages.flatMap((message) => message.parts),
        [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            name: 'Bash',
            state: 'done',
            input: { command: 'ls' },
            output: 'a.ts',
            isError: false
          }
        ]
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect('reads the stored conversation again after a read of it failed', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* reply(PANE_A, 'r1', 'stored')
      yield* sql`ALTER TABLE agent_items RENAME TO agent_items_hidden`
      const whileUnreadable = yield* textsOf(PANE_A)

      yield* sql`ALTER TABLE agent_items_hidden RENAME TO agent_items`

      assert.deepStrictEqual([whileUnreadable, yield* textsOf(PANE_A)], [[], ['stored']])
    }).pipe(Effect.provide(layer))
  })

  it.effect('includes an item stored while the tab was catching up', () => {
    const gate = Deferred.makeUnsafe<void>()
    const { layer } = makeSetup({ catchUpGate: Deferred.await(gate) })
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
      const seeding = yield* Effect.forkChild(seed(PANE_A))
      yield* settle

      yield* reply(PANE_A, 'r1', 'while catching up')
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(seeding)

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['while catching up', 'from s-1'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('serves another tab while one tab is still catching up', () => {
    const gate = Deferred.makeUnsafe<void>()
    const { layer } = makeSetup({ catchUpGate: Deferred.await(gate) })
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1'), tab(PANE_B)]))
      yield* Effect.forkChild(seed(PANE_A))
      yield* settle
      yield* reply(PANE_B, 'r1', 'other tab')

      const texts = yield* textsOf(PANE_B)

      assert.deepStrictEqual(texts, ['other tab'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('keeps the state it holds when seeded again', () => {
    const { catchUps, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
      yield* seed(PANE_A)
      yield* reply(PANE_A, 'r1', 'hi')

      yield* seed(PANE_A)

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1', 'hi'])
      assert.deepStrictEqual(catchUps, ['s-1'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('serves an id that is not a tab as empty and keeps nothing for it', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))

      const snapshot = yield* snapshotOf(PANE_B)
      yield* reply(PANE_B, 'r1', 'stray')

      assert.deepStrictEqual(snapshot, yield* snapshotOf(PANE_B))
      assert.deepStrictEqual(snapshot.state.attention, Idle.make({}))
      assert.strictEqual(snapshot.seq, 0)
    }).pipe(Effect.provide(layer))
  })

  it.effect('drops the state of a seeded pane that is not a tab once released', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_B)
      yield* reply(PANE_B, 'r1', 'hired agent reply')
      const before = yield* textsOf(PANE_B)

      yield* Effect.flatMap(PaneChatProjection, (projection) => projection.release(PANE_B))

      assert.deepStrictEqual([before, yield* textsOf(PANE_B)], [['hired agent reply'], []])
    }).pipe(Effect.provide(layer))
  })

  it.effect('keeps the state of a workspace tab when released', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_A)
      yield* reply(PANE_A, 'r1', 'tab reply')

      yield* Effect.flatMap(PaneChatProjection, (projection) => projection.release(PANE_A))

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['tab reply'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('follows a tab seeded before it joins the workspace', () => {
    const { layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_B)
      yield* reply(PANE_B, 'r1', 'setting up')

      yield* setWorkspace(workspaceOf([tab(PANE_A), tab(PANE_B)]))

      assert.deepStrictEqual(yield* textsOf(PANE_B), ['setting up'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('waits for an event still being folded before serving the snapshot', () => {
    const catalogReady = Deferred.makeUnsafe<void>()
    const { layer } = makeSetup({ catalogReady: Deferred.await(catalogReady) })
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A)]))
      yield* seed(PANE_A)
      yield* publish(PaneModelChanged.make({ paneId: PANE_A, model: 'sonnet' }))

      const pending = yield* Effect.forkChild(snapshotOf(PANE_A))
      yield* settle
      yield* Deferred.succeed(catalogReady, undefined)
      const snapshot = yield* Fiber.join(pending)

      assert.strictEqual(snapshot.seq, yield* lastSequence(PANE_A))
      assert.deepStrictEqual(yield* textsOf(PANE_A), ['Model → Sonnet'])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'keeps a tab that a stale workspace event leaves out but the workspace still has',
    () => {
      const { layer } = makeSetup()
      return Effect.gen(function* () {
        yield* setWorkspace(workspaceOf([tab(PANE_A)]))
        yield* seed(PANE_A)
        yield* reply(PANE_A, 'r1', 'hi')

        yield* publish(WorkspaceChanged.make({ workspace: workspaceOf([]) }))

        assert.deepStrictEqual(yield* textsOf(PANE_A), ['hi'])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect('rebuilds the state of a tab that leaves and rejoins from the store', () => {
    const { catchUps, layer } = makeSetup()
    return Effect.gen(function* () {
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
      yield* seed(PANE_A)
      yield* publish(
        PaneAttentionChanged.make({
          paneId: PANE_A,
          attention: Errored.make({ error: { message: 'boom' } })
        })
      )
      yield* reply(PANE_A, 'r1', 'hi')

      yield* setWorkspace(workspaceOf([]))
      yield* setWorkspace(workspaceOf([tab(PANE_A, 's-1')]))
      const snapshot = yield* snapshotOf(PANE_A)

      assert.deepStrictEqual(yield* textsOf(PANE_A), ['from s-1', 'hi'])
      assert.deepStrictEqual(snapshot.state.attention, Idle.make({}))
      assert.deepStrictEqual(catchUps, ['s-1', 's-1'])
    }).pipe(Effect.provide(layer))
  })
})
