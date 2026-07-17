import { assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Either, Layer, Option, Stream } from 'effect'
import type { PaneNode } from '../domain/pane-tree'
import type { IpcEvent } from '../ipc/contract'
import { WorktreeCreateError } from './git-ops-service'
import { type PaneHandle, PaneSupervisor } from './pane-supervisor'
import { makePaneWorkspaceLive, PaneWorkspace } from './pane-workspace'
import { type PersistedWorkspace, PersistenceService } from './persistence'

function secondLeafPaneId(tree: PaneNode): string {
  if (tree._tag !== 'Split') throw new Error('expected a Split')
  const second = tree.children[1]
  if (second._tag !== 'Leaf') throw new Error('expected a Leaf')
  return second.paneId
}

const INITIAL_PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const WORKTREES_ROOT = '/worktrees'

const fakeHandle: PaneHandle = {
  sendMessage: () => Effect.void,
  resolvePermission: () => Effect.void,
  subscribe: () => Stream.empty,
  markErrored: () => Effect.void
}

function makeSupervisorLayer(
  openPane: Context.Tag.Service<typeof PaneSupervisor>['openPane']
): Layer.Layer<PaneSupervisor> {
  return Layer.succeed(PaneSupervisor, {
    openPane,
    closePane: () => Effect.void,
    getHandle: () => Effect.succeed(Option.none()),
    closeAll: () => Effect.void
  })
}

function makePersistence(initial?: PersistedWorkspace): {
  readonly saves: Array<PersistedWorkspace>
  readonly layer: Layer.Layer<PersistenceService>
} {
  const saves: Array<PersistedWorkspace> = []
  const layer = Layer.succeed(PersistenceService, {
    loadWorkspace: () => Effect.succeed(Option.fromNullable(initial)),
    saveWorkspace: (workspace) =>
      Effect.sync(() => {
        saves.push(workspace)
      })
  })
  return { saves, layer }
}

function makeWorkspaceLayer(
  supervisorLayer: Layer.Layer<PaneSupervisor>,
  persistenceLayer: Layer.Layer<PersistenceService>
): Layer.Layer<PaneWorkspace> {
  return Layer.provide(
    makePaneWorkspaceLive(INITIAL_PANE_ID, WORKTREES_ROOT),
    Layer.merge(supervisorLayer, persistenceLayer)
  )
}

const echoOpenPane = (
  request: Parameters<Context.Tag.Service<typeof PaneSupervisor>['openPane']>[0]
): Effect.Effect<{ handle: PaneHandle; config: { paneId: string; cwd: string; model: string } }> =>
  Effect.succeed({
    handle: fakeHandle,
    config: { paneId: request.paneId, cwd: request.sourceCwd, model: request.model }
  })

const onEvent = (_event: IpcEvent): Effect.Effect<void> => Effect.void

describe('PaneWorkspace', () => {
  it.effect('seeds a pending leaf without opening a process when nothing is persisted', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.getTree()
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(openPaneCalls, 0)
      assert.deepStrictEqual(tree, {
        _tag: 'Leaf',
        paneId: INITIAL_PANE_ID,
        status: 'pending'
      })
    })
  )

  it.effect('hydrates the persisted tree without opening any process', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const restoredTree: PaneNode = {
        _tag: 'Split',
        direction: 'row',
        children: [
          { _tag: 'Leaf', paneId: INITIAL_PANE_ID, status: 'ready', cwd: '/repo/a' },
          {
            _tag: 'Leaf',
            paneId: 'bbbbbbbb-0000-4000-8000-000000000002',
            status: 'ready',
            cwd: '/wt/b',
            sourceRepo: '/repo'
          }
        ],
        sizes: [0.5, 0.5]
      }
      const { layer: persistenceLayer } = makePersistence({
        tree: restoredTree,
        panes: {
          [INITIAL_PANE_ID]: {
            config: { paneId: INITIAL_PANE_ID, cwd: '/repo/a', model: 'm' }
          }
        }
      })

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.getTree()
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(openPaneCalls, 0)
      assert.deepStrictEqual(tree, restoredTree)
    })
  )

  it.effect('persists the workspace after createPane, recording the pane config', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { saves, layer: persistenceLayer } = makePersistence()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'model-x', false, onEvent)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(saves.length, 1)
      const snapshot = saves[0]
      assert.deepStrictEqual(snapshot.panes[INITIAL_PANE_ID], {
        config: { paneId: INITIAL_PANE_ID, cwd: '/repo', model: 'model-x' }
      })
      if (snapshot.tree._tag === 'Leaf') {
        assert.strictEqual(snapshot.tree.status, 'ready')
      } else {
        throw new Error('expected a ready leaf')
      }
    })
  )

  it.effect('persists the workspace after split, matching the returned tree', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { saves, layer: persistenceLayer } = makePersistence()

      const splitTree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        return yield* workspace.split(INITIAL_PANE_ID, 'row')
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      // createPane saves once, split saves again -> the last snapshot is the split.
      assert.strictEqual(saves.length, 2)
      assert.deepStrictEqual(saves[1].tree, splitTree)
    })
  )

  it.effect('preserves a restored pane sessionId across a later save', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { saves, layer: persistenceLayer } = makePersistence({
        tree: { _tag: 'Leaf', paneId: INITIAL_PANE_ID, status: 'ready', cwd: '/repo' },
        panes: {
          [INITIAL_PANE_ID]: {
            config: { paneId: INITIAL_PANE_ID, cwd: '/repo', model: 'm' },
            sessionId: 'restored-session-1'
          }
        }
      })

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.split(INITIAL_PANE_ID, 'column')
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(saves.length, 1)
      assert.strictEqual(saves[0].panes[INITIAL_PANE_ID].sessionId, 'restored-session-1')
    })
  )

  it.effect('split creates a pending leaf without opening a process', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        return yield* workspace.split(INITIAL_PANE_ID, 'row')
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      // Only the initial createPane call should have opened a process; split itself must not.
      assert.strictEqual(openPaneCalls, 1)
      assert.deepStrictEqual(tree, {
        _tag: 'Split',
        direction: 'row',
        children: [
          {
            _tag: 'Leaf',
            paneId: INITIAL_PANE_ID,
            status: 'ready',
            cwd: '/repo',
            sourceRepo: undefined
          },
          { _tag: 'Leaf', paneId: secondLeafPaneId(tree), status: 'pending' }
        ],
        sizes: [0.5, 0.5]
      })
    })
  )

  it.effect('createPane flips a pending leaf to ready on success', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        const split = yield* workspace.split(INITIAL_PANE_ID, 'row')
        const newPaneId = secondLeafPaneId(split)
        return yield* workspace.createPane(newPaneId, '/other', 'm', false, onEvent)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.isTrue(tree._tag === 'Split')
      if (tree._tag === 'Split') {
        assert.deepStrictEqual(
          tree.children.map((child) => (child._tag === 'Leaf' ? child.status : child._tag)),
          ['ready', 'ready']
        )
      }
    })
  )

  it.effect('createPane propagates a WorktreeCreateError and leaves the leaf pending', () =>
    Effect.gen(function* () {
      const error = new WorktreeCreateError({
        paneId: 'bbbbbbbb-0000-4000-8000-000000000002',
        sourceRepo: '/other',
        cause: 'boom'
      })
      const supervisorLayer = makeSupervisorLayer((request) =>
        request.paneId === INITIAL_PANE_ID ? echoOpenPane(request) : Effect.fail(error)
      )
      const { layer: persistenceLayer } = makePersistence()

      const result = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        const split = yield* workspace.split(INITIAL_PANE_ID, 'row')
        const newPaneId = secondLeafPaneId(split)
        return yield* workspace
          .createPane(newPaneId, '/other', 'm', true, onEvent)
          .pipe(Effect.either)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.isTrue(Either.isLeft(result))
      if (Either.isLeft(result)) {
        assert.instanceOf(result.left, WorktreeCreateError)
      }
    })
  )

  it.effect('closing the last remaining pane resets it to a pending leaf', () =>
    Effect.gen(function* () {
      let closePaneCalls = 0
      const supervisorLayer = Layer.succeed(PaneSupervisor, {
        openPane: echoOpenPane,
        closePane: () => {
          closePaneCalls++
          return Effect.void
        },
        getHandle: () => Effect.succeed(Option.none()),
        closeAll: () => Effect.void
      })
      const { saves, layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        return yield* workspace.close(INITIAL_PANE_ID)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(closePaneCalls, 1)
      assert.deepStrictEqual(tree, {
        _tag: 'Leaf',
        paneId: INITIAL_PANE_ID,
        status: 'pending'
      })
      // createPane saved once, close saved again with the pane removed from the index.
      assert.strictEqual(saves.length, 2)
      assert.deepStrictEqual(saves[1].panes, {})
    })
  )
})
