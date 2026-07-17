import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, Effect, Either, HashMap, Layer, Option, Ref } from 'effect'
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
import { type PersistedPaneEntry, PersistenceService } from './persistence'

/**
 * Service tag for the pane workspace: owns the pane tree and per-pane configs, and
 * coordinates splitting, creating, and closing panes against the {@link PaneSupervisor}.
 * Depend on this tag wherever pane layout or lifecycle needs to be read or mutated.
 */
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

/**
 * Builds the live {@link PaneWorkspace} layer, requiring {@link PaneSupervisor} and
 * {@link PersistenceService} from context. On construction it hydrates from the persisted
 * workspace (tree + per-pane index): if one exists it is restored as-is (panes stay cold --
 * no processes are spawned here); otherwise the workspace is seeded with a single pending
 * leaf pane (`initialPaneId`), since there is no valid `PaneNode` representing zero panes --
 * the user fills in its working directory through the same onboarding form used for any
 * freshly-split pane. Thereafter this is the single writer of the persisted workspace,
 * re-saving after every `split`/`createPane`/`close`. `worktreesRoot` is the base directory
 * under which per-pane git worktrees are created when `createPane` is called with
 * `useWorktree: true`.
 */
export const makePaneWorkspaceLive = (initialPaneId: PaneId, worktreesRoot: string) =>
  Layer.effect(
    PaneWorkspace,
    Effect.gen(function* () {
      const supervisor = yield* PaneSupervisor
      const persistence = yield* PersistenceService

      const persisted = yield* persistence.loadWorkspace()
      const seed = Option.match(persisted, {
        onNone: () => ({
          tree: { _tag: 'Leaf', paneId: initialPaneId, status: 'pending' } satisfies PaneNode,
          panes: HashMap.empty<PaneId, PersistedPaneEntry>()
        }),
        onSome: (workspace) => ({
          tree: workspace.tree,
          panes: HashMap.fromIterable(Object.entries(workspace.panes))
        })
      })

      const treeRef = yield* Ref.make<PaneNode>(seed.tree)
      const configsRef = yield* Ref.make(seed.panes)

      const save = Effect.fn('PaneWorkspace.save')(function* () {
        const tree = yield* Ref.get(treeRef)
        const configs = yield* Ref.get(configsRef)
        const panes: Record<string, PersistedPaneEntry> = {}
        for (const [paneId, entry] of configs) {
          panes[paneId] = entry
        }
        yield* persistence
          .saveWorkspace({ tree, panes })
          .pipe(
            Effect.catchAll((cause) => Effect.logError('Failed to persist workspace', { cause }))
          )
      })

      const recordSessionId = Effect.fn('PaneWorkspace.recordSessionId')(function* (
        paneId: PaneId,
        sessionId: string
      ) {
        const configs = yield* Ref.get(configsRef)
        const entry = HashMap.get(configs, paneId)
        if (Option.isNone(entry)) {
          yield* Effect.logWarning('Received sessionId for a pane not in the index', { paneId })
          return
        }
        yield* Ref.set(configsRef, HashMap.set(configs, paneId, { ...entry.value, sessionId }))
        yield* save()
      })

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
        yield* save()
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
          onCreateEvent,
          (sessionId) => recordSessionId(paneId, sessionId)
        )

        const readyTree = markPaneReady(tree, paneId, config.cwd, config.worktree?.sourceRepo)
        if (Either.isLeft(readyTree)) {
          return yield* Effect.fail(readyTree.left)
        }

        yield* Ref.set(treeRef, readyTree.right)
        yield* Ref.update(configsRef, HashMap.set(paneId, { config }))
        yield* save()
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
          yield* save()
          return resetTree
        }

        yield* supervisor.closePane(paneId)
        yield* Ref.set(treeRef, updated.right)
        yield* Ref.update(configsRef, HashMap.remove(paneId))
        yield* save()
        return updated.right
      })

      return { getTree, split, createPane, close }
    })
  )
