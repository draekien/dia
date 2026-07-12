import { randomUUID } from 'node:crypto'
import { Context, Effect, Either, HashMap, Layer, Option, Ref } from 'effect'
import type { PaneConfig } from '../domain/pane'
import {
  closePane,
  type LastPaneError,
  type PaneId,
  type PaneNode,
  PaneNotFoundError,
  splitPane
} from '../domain/pane-tree'
import type { IpcEvent } from '../ipc/contract'
import { PaneSupervisor, type ProcessSpawnError } from './pane-supervisor'

export class PaneWorkspace extends Context.Tag('PaneWorkspace')<
  PaneWorkspace,
  {
    readonly getTree: () => Effect.Effect<PaneNode>
    readonly split: (
      paneId: PaneId,
      direction: 'row' | 'column',
      onEvent: (event: IpcEvent) => Effect.Effect<void>
    ) => Effect.Effect<PaneNode, PaneNotFoundError | ProcessSpawnError>
    readonly close: (paneId: PaneId) => Effect.Effect<PaneNode, PaneNotFoundError | LastPaneError>
  }
>() {}

// Only PaneWorkspace's own initialization can produce the first pane, since PaneTreeService's
// pure transforms all start from an existing tree -- there is no valid PaneNode for zero panes.
export const makePaneWorkspaceLive = (
  initialConfig: PaneConfig,
  onEvent: (event: IpcEvent) => Effect.Effect<void>
) =>
  Layer.effect(
    PaneWorkspace,
    Effect.gen(function* () {
      const supervisor = yield* PaneSupervisor
      yield* supervisor.openPane(initialConfig, onEvent)

      const treeRef = yield* Ref.make<PaneNode>({ _tag: 'Leaf', paneId: initialConfig.paneId })
      const configsRef = yield* Ref.make<HashMap.HashMap<PaneId, PaneConfig>>(
        HashMap.make([initialConfig.paneId, initialConfig])
      )

      const getTree = () => Ref.get(treeRef)

      const split = (
        paneId: PaneId,
        direction: 'row' | 'column',
        onSplitEvent: (event: IpcEvent) => Effect.Effect<void>
      ) =>
        Effect.gen(function* () {
          const configs = yield* Ref.get(configsRef)
          const parentConfig = HashMap.get(configs, paneId)
          if (Option.isNone(parentConfig)) {
            return yield* Effect.fail(new PaneNotFoundError({ paneId }))
          }

          const newPaneId: PaneId = randomUUID()
          const tree = yield* Ref.get(treeRef)
          const updated = splitPane(tree, paneId, direction, newPaneId)
          if (Either.isLeft(updated)) {
            return yield* Effect.fail(updated.left)
          }

          const newConfig: PaneConfig = {
            paneId: newPaneId,
            cwd: parentConfig.value.cwd,
            model: parentConfig.value.model
          }
          yield* supervisor.openPane(newConfig, onSplitEvent)

          yield* Ref.set(treeRef, updated.right)
          yield* Ref.update(configsRef, HashMap.set(newPaneId, newConfig))
          return updated.right
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

      return { getTree, split, close }
    })
  )
