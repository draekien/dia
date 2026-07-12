import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, Effect, Either, HashMap, Layer, Ref } from 'effect'
import type { PaneConfig } from '../domain/pane'
import {
  closePane,
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
    readonly close: (paneId: PaneId) => Effect.Effect<PaneNode, PaneNotFoundError>
  }
>() {}

// Only PaneWorkspace's own initialization can produce the first pane, since PaneTreeService's
// pure transforms all start from an existing tree -- there is no valid PaneNode for zero panes.
// It seeds as a pending leaf, same as any freshly-split pane, so the user picks its working
// directory through the same onboarding form rather than the app assuming one for them.
export const makePaneWorkspaceLive = (initialPaneId: PaneId, worktreesRoot: string) =>
  Layer.effect(
    PaneWorkspace,
    Effect.gen(function* () {
      const supervisor = yield* PaneSupervisor

      const treeRef = yield* Ref.make<PaneNode>({
        _tag: 'Leaf',
        paneId: initialPaneId,
        status: 'pending'
      })
      const configsRef = yield* Ref.make<HashMap.HashMap<PaneId, PaneConfig>>(HashMap.empty())

      const getTree = () => Ref.get(treeRef)

      const split = Effect.fn('PaneWorkspace.split')(function* (
        paneId: PaneId,
        direction: 'row' | 'column'
      ) {
        const newPaneId: PaneId = randomUUID()
        const tree = yield* Ref.get(treeRef)
        const updated = splitPane(tree, paneId, direction, newPaneId)
        if (Either.isLeft(updated)) {
          return yield* Effect.fail(updated.left)
        }

        yield* Ref.set(treeRef, updated.right)
        return updated.right
      })

      const createPane = Effect.fn('PaneWorkspace.createPane')(function* (
        paneId: PaneId,
        sourceCwd: string,
        model: string,
        useWorktree: boolean,
        onCreateEvent: (event: IpcEvent) => Effect.Effect<void>
      ) {
        const tree = yield* Ref.get(treeRef)
        // Validate paneId is a pending leaf before spawning anything; the cwd here is a
        // placeholder discarded below once the real (possibly worktree) cwd is known.
        const precheck = markPaneReady(tree, paneId, sourceCwd)
        if (Either.isLeft(precheck)) {
          return yield* Effect.fail(precheck.left)
        }

        const worktreePath = useWorktree ? join(worktreesRoot, paneId) : undefined
        const { config } = yield* supervisor.openPane(
          { paneId, sourceCwd, model, worktreePath },
          onCreateEvent
        )

        const readyTree = markPaneReady(tree, paneId, config.cwd, config.worktree?.sourceRepo)
        if (Either.isLeft(readyTree)) {
          return yield* Effect.fail(readyTree.left)
        }

        yield* Ref.set(treeRef, readyTree.right)
        yield* Ref.update(configsRef, HashMap.set(paneId, config))
        return readyTree.right
      })

      const close = Effect.fn('PaneWorkspace.close')(function* (paneId: PaneId) {
        const tree = yield* Ref.get(treeRef)
        const updated = closePane(tree, paneId)
        if (Either.isLeft(updated)) {
          if (updated.left._tag === 'PaneNotFoundError') {
            return yield* Effect.fail(updated.left)
          }
          // Closing the workspace's last remaining pane doesn't leave an empty workspace --
          // it tears down that pane and resets it to a fresh pending leaf, so the onboarding
          // form reappears instead of the app being left with nothing to show.
          yield* supervisor.closePane(paneId)
          const resetTree: PaneNode = { _tag: 'Leaf', paneId, status: 'pending' }
          yield* Ref.set(treeRef, resetTree)
          yield* Ref.update(configsRef, HashMap.remove(paneId))
          return resetTree
        }

        yield* supervisor.closePane(paneId)
        yield* Ref.set(treeRef, updated.right)
        yield* Ref.update(configsRef, HashMap.remove(paneId))
        return updated.right
      })

      return { getTree, split, createPane, close }
    })
  )
