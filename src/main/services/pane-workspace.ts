import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, Effect, Either, HashMap, Layer, Ref } from 'effect'
import type { PaneConfig } from '../domain/pane'
import {
  closePane,
  type LastPaneError,
  markPaneReady,
  type PaneId,
  type PaneNode,
  type PaneNotFoundError,
  splitPane
} from '../domain/pane-tree'
import type { IpcEvent } from '../ipc/contract'
import type { WorktreeCreateError } from './git-ops-service'
import { PaneSupervisor, type ProcessSpawnError } from './pane-supervisor'

export class PaneWorkspace extends Context.Tag('PaneWorkspace')<
  PaneWorkspace,
  {
    readonly getTree: () => Effect.Effect<PaneNode>
    readonly split: (
      paneId: PaneId,
      direction: 'row' | 'column'
    ) => Effect.Effect<PaneNode, PaneNotFoundError>
    readonly createPane: (
      paneId: PaneId,
      sourceCwd: string,
      model: string,
      useWorktree: boolean,
      onEvent: (event: IpcEvent) => Effect.Effect<void>
    ) => Effect.Effect<PaneNode, PaneNotFoundError | ProcessSpawnError | WorktreeCreateError>
    readonly close: (paneId: PaneId) => Effect.Effect<PaneNode, PaneNotFoundError | LastPaneError>
  }
>() {}

// Only PaneWorkspace's own initialization can produce the first pane, since PaneTreeService's
// pure transforms all start from an existing tree -- there is no valid PaneNode for zero panes.
// The seeded pane is never worktree-backed and starts ready, not pending.
export const makePaneWorkspaceLive = (
  initialConfig: PaneConfig,
  worktreesRoot: string,
  onEvent: (event: IpcEvent) => Effect.Effect<void>
) =>
  Layer.effect(
    PaneWorkspace,
    Effect.gen(function* () {
      const supervisor = yield* PaneSupervisor
      yield* supervisor.openPane(
        {
          paneId: initialConfig.paneId,
          sourceCwd: initialConfig.cwd,
          model: initialConfig.model,
          worktreePath: undefined
        },
        onEvent
      )

      const treeRef = yield* Ref.make<PaneNode>({
        _tag: 'Leaf',
        paneId: initialConfig.paneId,
        status: 'ready'
      })
      const configsRef = yield* Ref.make<HashMap.HashMap<PaneId, PaneConfig>>(
        HashMap.make([initialConfig.paneId, initialConfig])
      )

      const getTree = () => Ref.get(treeRef)

      const split = (paneId: PaneId, direction: 'row' | 'column') =>
        Effect.gen(function* () {
          const newPaneId: PaneId = randomUUID()
          const tree = yield* Ref.get(treeRef)
          const updated = splitPane(tree, paneId, direction, newPaneId)
          if (Either.isLeft(updated)) {
            return yield* Effect.fail(updated.left)
          }

          yield* Ref.set(treeRef, updated.right)
          return updated.right
        })

      const createPane = (
        paneId: PaneId,
        sourceCwd: string,
        model: string,
        useWorktree: boolean,
        onCreateEvent: (event: IpcEvent) => Effect.Effect<void>
      ) =>
        Effect.gen(function* () {
          const tree = yield* Ref.get(treeRef)
          const readyTree = markPaneReady(tree, paneId)
          if (Either.isLeft(readyTree)) {
            return yield* Effect.fail(readyTree.left)
          }

          const worktreePath = useWorktree ? join(worktreesRoot, paneId) : undefined
          const { config } = yield* supervisor.openPane(
            { paneId, sourceCwd, model, worktreePath },
            onCreateEvent
          )

          yield* Ref.set(treeRef, readyTree.right)
          yield* Ref.update(configsRef, HashMap.set(paneId, config))
          return readyTree.right
        })

      const close = (paneId: PaneId) =>
        Effect.gen(function* () {
          const tree = yield* Ref.get(treeRef)
          const updated = closePane(tree, paneId)
          if (Either.isLeft(updated)) {
            return yield* Effect.fail(updated.left)
          }

          yield* supervisor.closePane(paneId)
          yield* Ref.set(treeRef, updated.right)
          yield* Ref.update(configsRef, HashMap.remove(paneId))
          return updated.right
        })

      return { getTree, split, createPane, close }
    })
  )
