import { assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Either, Layer, Option, Stream } from 'effect'
import type { PaneNode } from '../domain/pane-tree'
import type { IpcEvent } from '../ipc/contract'
import { WorktreeCreateError } from './git-ops-service'
import { type PaneHandle, PaneSupervisor } from './pane-supervisor'
import { makePaneWorkspaceLive, PaneWorkspace } from './pane-workspace'

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

const onEvent = (_event: IpcEvent): Effect.Effect<void> => Effect.void

describe('PaneWorkspace', () => {
  it.effect('seeds a pending leaf without opening a process', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return Effect.succeed({
          handle: fakeHandle,
          config: { paneId: request.paneId, cwd: request.sourceCwd, model: request.model }
        })
      })
      const workspaceLayer = Layer.provide(
        makePaneWorkspaceLive(INITIAL_PANE_ID, WORKTREES_ROOT),
        supervisorLayer
      )

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.getTree()
      }).pipe(Effect.provide(workspaceLayer))

      assert.strictEqual(openPaneCalls, 0)
      assert.deepStrictEqual(tree, {
        _tag: 'Leaf',
        paneId: INITIAL_PANE_ID,
        status: 'pending'
      })
    })
  )

  it.effect('split creates a pending leaf without opening a process', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return Effect.succeed({
          handle: fakeHandle,
          config: { paneId: request.paneId, cwd: request.sourceCwd, model: request.model }
        })
      })
      const workspaceLayer = Layer.provide(
        makePaneWorkspaceLive(INITIAL_PANE_ID, WORKTREES_ROOT),
        supervisorLayer
      )

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        return yield* workspace.split(INITIAL_PANE_ID, 'row')
      }).pipe(Effect.provide(workspaceLayer))

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
      const supervisorLayer = makeSupervisorLayer((request) =>
        Effect.succeed({
          handle: fakeHandle,
          config: { paneId: request.paneId, cwd: request.sourceCwd, model: request.model }
        })
      )
      const workspaceLayer = Layer.provide(
        makePaneWorkspaceLive(INITIAL_PANE_ID, WORKTREES_ROOT),
        supervisorLayer
      )

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        const split = yield* workspace.split(INITIAL_PANE_ID, 'row')
        const newPaneId = secondLeafPaneId(split)
        return yield* workspace.createPane(newPaneId, '/other', 'm', false, onEvent)
      }).pipe(Effect.provide(workspaceLayer))

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
        request.paneId === INITIAL_PANE_ID
          ? Effect.succeed({
              handle: fakeHandle,
              config: { paneId: request.paneId, cwd: request.sourceCwd, model: request.model }
            })
          : Effect.fail(error)
      )
      const workspaceLayer = Layer.provide(
        makePaneWorkspaceLive(INITIAL_PANE_ID, WORKTREES_ROOT),
        supervisorLayer
      )

      const result = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        const split = yield* workspace.split(INITIAL_PANE_ID, 'row')
        const newPaneId = secondLeafPaneId(split)
        return yield* workspace
          .createPane(newPaneId, '/other', 'm', true, onEvent)
          .pipe(Effect.either)
      }).pipe(Effect.provide(workspaceLayer))

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
        openPane: (request) =>
          Effect.succeed({
            handle: fakeHandle,
            config: { paneId: request.paneId, cwd: request.sourceCwd, model: request.model }
          }),
        closePane: () => {
          closePaneCalls++
          return Effect.void
        },
        getHandle: () => Effect.succeed(Option.none()),
        closeAll: () => Effect.void
      })
      const workspaceLayer = Layer.provide(
        makePaneWorkspaceLive(INITIAL_PANE_ID, WORKTREES_ROOT),
        supervisorLayer
      )

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', false, onEvent)
        return yield* workspace.close(INITIAL_PANE_ID)
      }).pipe(Effect.provide(workspaceLayer))

      assert.strictEqual(closePaneCalls, 1)
      assert.deepStrictEqual(tree, {
        _tag: 'Leaf',
        paneId: INITIAL_PANE_ID,
        status: 'pending'
      })
    })
  )
})
