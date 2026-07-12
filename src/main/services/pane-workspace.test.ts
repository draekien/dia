import { assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Either, Layer, Option, Stream } from 'effect'
import type { PaneConfig } from '../domain/pane'
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

const INITIAL_CONFIG: PaneConfig = {
  paneId: 'aaaaaaaa-0000-4000-8000-000000000001',
  cwd: '/repo',
  model: 'm'
}

const WORKTREES_ROOT = '/worktrees'

const fakeHandle: PaneHandle = {
  sendMessage: () => Effect.void,
  resolvePermission: () => Effect.void,
  subscribe: () => Stream.empty
}

function makeSupervisorLayer(
  openPane: Context.Tag.Service<typeof PaneSupervisor>['openPane']
): Layer.Layer<PaneSupervisor> {
  return Layer.succeed(PaneSupervisor, {
    openPane,
    closePane: () => Effect.void,
    getHandle: () => Effect.succeed(Option.none())
  })
}

const onEvent = (_event: IpcEvent): Effect.Effect<void> => Effect.void

describe('PaneWorkspace', () => {
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
        makePaneWorkspaceLive(INITIAL_CONFIG, WORKTREES_ROOT, onEvent),
        supervisorLayer
      )

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.split(INITIAL_CONFIG.paneId, 'row')
      }).pipe(Effect.provide(workspaceLayer))

      // The initial pane's openPane call happens during layer construction;
      // split itself must not trigger another one.
      assert.strictEqual(openPaneCalls, 1)
      assert.deepStrictEqual(tree, {
        _tag: 'Split',
        direction: 'row',
        children: [
          { _tag: 'Leaf', paneId: INITIAL_CONFIG.paneId, status: 'ready' },
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
        makePaneWorkspaceLive(INITIAL_CONFIG, WORKTREES_ROOT, onEvent),
        supervisorLayer
      )

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        const split = yield* workspace.split(INITIAL_CONFIG.paneId, 'row')
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
        request.paneId === INITIAL_CONFIG.paneId
          ? Effect.succeed({
              handle: fakeHandle,
              config: { paneId: request.paneId, cwd: request.sourceCwd, model: request.model }
            })
          : Effect.fail(error)
      )
      const workspaceLayer = Layer.provide(
        makePaneWorkspaceLive(INITIAL_CONFIG, WORKTREES_ROOT, onEvent),
        supervisorLayer
      )

      const result = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        const split = yield* workspace.split(INITIAL_CONFIG.paneId, 'row')
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
})
