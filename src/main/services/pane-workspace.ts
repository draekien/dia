import { randomUUID } from 'node:crypto'
import { FileSystem, Path } from '@effect/platform'
import { Errored } from '@shared/domain/attention'
import type {
  ConversationMessage,
  PermissionMode,
  StartupPermissionMode,
  ThinkingLevel
} from '@shared/domain/pane'
import {
  closePane,
  markPaneReady,
  type PaneId,
  PaneLeafSchema,
  type PaneNode,
  type PaneNotFoundError,
  setPanePermissionMode,
  setPaneThinkingLevel,
  splitPane
} from '@shared/domain/pane-tree'
import { type IpcEvent, LayoutChanged, PaneAttentionChanged } from '@shared/ipc/contract'
import { Context, Effect, Either, HashMap, Layer, Option, Ref } from 'effect'
import type { WorktreeCreateError, WorktreeReattachError } from './git-ops-service'
import { type PaneCreationRequest, PaneSupervisor, type ProcessSpawnError } from './pane-supervisor'
import { type PersistedPaneEntry, PersistenceService } from './persistence'
import { TranscriptReader } from './transcript-reader'

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
      thinkingLevel: ThinkingLevel,
      permissionMode: StartupPermissionMode,
      useWorktree: boolean,
      onEvent: (event: IpcEvent) => Effect.Effect<void>
    ) => Effect.Effect<
      PaneNode,
      PaneNotFoundError | ProcessSpawnError | WorktreeCreateError | WorktreeReattachError
    >
    /**
     * Changes a pane's thinking level: persists it on the pane's config, records it on the layout
     * tree, and, when the pane is live, forwards it to the running process (which applies it on the
     * next user turn). Returns the resulting layout tree so the caller can broadcast it. Leaves the
     * tree unchanged (and still returns it) for an unknown pane.
     */
    readonly setThinkingLevel: (paneId: PaneId, level: ThinkingLevel) => Effect.Effect<PaneNode>
    /**
     * Changes a pane's permission mode: persists it on the pane's config, records it on the layout
     * tree, and, when the pane is live, forwards it to the running process (which applies it to the
     * live session immediately). Returns the resulting layout tree so the caller can broadcast it.
     * Leaves the tree unchanged (and still returns it) for an unknown pane.
     */
    readonly setPermissionMode: (paneId: PaneId, mode: PermissionMode) => Effect.Effect<PaneNode>
    readonly close: (paneId: PaneId) => Effect.Effect<PaneNode, PaneNotFoundError>
    readonly getPaneHistory: (paneId: PaneId) => Effect.Effect<ReadonlyArray<ConversationMessage>>
    /**
     * Resumes a cold (restored-but-not-live) pane's Agent SDK session, streaming its events
     * through `onEvent`. Idempotent: a no-op when the pane already has a live handle, when it is
     * unknown, or when it has no recorded session to resume. Handles its own failures -- a gone
     * non-worktree working directory, or a spawn/reattach failure -- by logging and emitting an
     * `Errored` attention event rather than failing the effect.
     */
    readonly resumePane: (
      paneId: PaneId,
      onEvent: (event: IpcEvent) => Effect.Effect<void>
    ) => Effect.Effect<void>
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
 * `useWorktree: true`. Also requires {@link TranscriptReader} to serve `getPaneHistory`
 * for restored panes without spawning a live session, `FileSystem` to detect a resumed
 * non-worktree pane whose working directory has since been deleted, and `Path` to compose
 * per-pane worktree paths under `worktreesRoot`.
 */
export const makePaneWorkspaceLive = (initialPaneId: PaneId, worktreesRoot: string) =>
  Layer.effect(
    PaneWorkspace,
    Effect.gen(function* () {
      const supervisor = yield* PaneSupervisor
      const persistence = yield* PersistenceService
      const transcriptReader = yield* TranscriptReader
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const persisted = yield* persistence.loadWorkspace()
      const seed = Option.match(persisted, {
        onNone: () => ({
          tree: PaneLeafSchema.make({ paneId: initialPaneId, status: 'pending' }),
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

      // Persists a permission-mode change the pane made on its own (a plan was approved, restoring
      // the pre-plan mode) onto its config and the layout tree, then broadcasts the updated tree so
      // the renderer's mode selector reflects it. User-initiated changes go through setPermissionMode
      // instead; this is only for changes originating in the pane process.
      const recordPermissionMode = Effect.fn('PaneWorkspace.recordPermissionMode')(function* (
        paneId: PaneId,
        mode: PermissionMode,
        onEvent: (event: IpcEvent) => Effect.Effect<void>
      ) {
        const configs = yield* Ref.get(configsRef)
        const entry = HashMap.get(configs, paneId)
        if (Option.isNone(entry)) {
          yield* Effect.logWarning('Received permission mode for a pane not in the index', {
            paneId
          })
          return
        }
        yield* Ref.set(
          configsRef,
          HashMap.set(configs, paneId, {
            ...entry.value,
            config: { ...entry.value.config, permissionMode: mode }
          })
        )

        const tree = yield* Ref.get(treeRef)
        const updated = setPanePermissionMode(tree, paneId, mode)
        if (Either.isRight(updated)) {
          yield* Ref.set(treeRef, updated.right)
          yield* save()
          yield* onEvent(LayoutChanged.make({ tree: updated.right }))
        } else {
          yield* save()
        }
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
          return yield* updated.left
        }

        yield* Ref.set(treeRef, updated.right)
        yield* save()
        return updated.right
      })

      const createPane = Effect.fn('PaneWorkspace.createPane')(function* (
        paneId: PaneId,
        sourceCwd: string,
        model: string,
        thinkingLevel: ThinkingLevel,
        permissionMode: StartupPermissionMode,
        useWorktree: boolean,
        onCreateEvent: (event: IpcEvent) => Effect.Effect<void>
      ) {
        const tree = yield* Ref.get(treeRef)
        // Validate paneId is a pending leaf before spawning anything; the cwd here is a
        // placeholder discarded below once the real (possibly worktree) cwd is known.
        const precheck = markPaneReady(tree, paneId, sourceCwd)
        if (Either.isLeft(precheck)) {
          return yield* precheck.left
        }

        const worktreePath = useWorktree ? path.join(worktreesRoot, paneId) : undefined
        const { config } = yield* supervisor.openPane(
          { paneId, sourceCwd, model, thinkingLevel, permissionMode, worktreePath },
          onCreateEvent,
          (sessionId) => recordSessionId(paneId, sessionId),
          (mode) => recordPermissionMode(paneId, mode, onCreateEvent)
        )

        const readyTree = markPaneReady(
          tree,
          paneId,
          config.cwd,
          config.worktree?.sourceRepo,
          config.thinkingLevel,
          config.permissionMode
        )
        if (Either.isLeft(readyTree)) {
          return yield* readyTree.left
        }

        yield* Ref.set(treeRef, readyTree.right)
        yield* Ref.update(configsRef, HashMap.set(paneId, { config }))
        yield* save()
        return readyTree.right
      })

      const setThinkingLevel = Effect.fn('PaneWorkspace.setThinkingLevel')(function* (
        paneId: PaneId,
        level: ThinkingLevel
      ) {
        const configs = yield* Ref.get(configsRef)
        const entry = HashMap.get(configs, paneId)
        if (Option.isNone(entry)) {
          yield* Effect.logWarning('setThinkingLevel for a pane not in the index', { paneId })
          return yield* Ref.get(treeRef)
        }

        yield* Ref.set(
          configsRef,
          HashMap.set(configs, paneId, {
            ...entry.value,
            config: { ...entry.value.config, thinkingLevel: level }
          })
        )

        const tree = yield* Ref.get(treeRef)
        const updated = setPaneThinkingLevel(tree, paneId, level)
        const nextTree = Either.isRight(updated) ? updated.right : tree
        if (Either.isRight(updated)) yield* Ref.set(treeRef, updated.right)
        yield* save()

        const handle = yield* supervisor.getHandle(paneId)
        if (Option.isSome(handle)) {
          yield* handle.value.setThinkingLevel(level)
        }

        return nextTree
      })

      const setPermissionMode = Effect.fn('PaneWorkspace.setPermissionMode')(function* (
        paneId: PaneId,
        mode: PermissionMode
      ) {
        const configs = yield* Ref.get(configsRef)
        const entry = HashMap.get(configs, paneId)
        if (Option.isNone(entry)) {
          yield* Effect.logWarning('setPermissionMode for a pane not in the index', { paneId })
          return yield* Ref.get(treeRef)
        }

        yield* Ref.set(
          configsRef,
          HashMap.set(configs, paneId, {
            ...entry.value,
            config: { ...entry.value.config, permissionMode: mode }
          })
        )

        const tree = yield* Ref.get(treeRef)
        const updated = setPanePermissionMode(tree, paneId, mode)
        const nextTree = Either.isRight(updated) ? updated.right : tree
        if (Either.isRight(updated)) yield* Ref.set(treeRef, updated.right)
        yield* save()

        const handle = yield* supervisor.getHandle(paneId)
        if (Option.isSome(handle)) {
          yield* handle.value.setPermissionMode(mode)
        }

        return nextTree
      })

      const close = Effect.fn('PaneWorkspace.close')(function* (paneId: PaneId) {
        const tree = yield* Ref.get(treeRef)
        const updated = closePane(tree, paneId)
        if (Either.isLeft(updated)) {
          if (updated.left._tag === 'PaneNotFoundError') {
            return yield* updated.left
          }
          // Closing the workspace's last remaining pane doesn't leave an empty workspace --
          // it tears down that pane and resets it to a fresh pending leaf, so the onboarding
          // form reappears instead of the app being left with nothing to show.
          yield* supervisor.closePane(paneId)
          const resetTree: PaneNode = PaneLeafSchema.make({ paneId, status: 'pending' })
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

      const getPaneHistory = Effect.fn('PaneWorkspace.getPaneHistory')(function* (paneId: PaneId) {
        const configs = yield* Ref.get(configsRef)
        const entry = HashMap.get(configs, paneId)
        if (Option.isNone(entry) || entry.value.sessionId === undefined) {
          return []
        }
        return yield* transcriptReader.readHistory(entry.value.sessionId, entry.value.config.cwd)
      })

      const emitErrored = (
        paneId: PaneId,
        onEvent: (event: IpcEvent) => Effect.Effect<void>,
        message: string
      ): Effect.Effect<void> =>
        onEvent(
          PaneAttentionChanged.make({
            paneId,
            attention: Errored.make({ error: { message } })
          })
        )

      const resumePane = Effect.fn('PaneWorkspace.resumePane')(function* (
        paneId: PaneId,
        onEvent: (event: IpcEvent) => Effect.Effect<void>
      ) {
        const existing = yield* supervisor.getHandle(paneId)
        if (Option.isSome(existing)) return

        const configs = yield* Ref.get(configsRef)
        const entry = HashMap.get(configs, paneId)
        if (Option.isNone(entry)) {
          yield* Effect.logWarning('resumePane for a pane not in the index', { paneId })
          return
        }

        const { config, sessionId } = entry.value
        if (sessionId === undefined) {
          yield* Effect.logDebug('resumePane skipped; pane has no session to resume', { paneId })
          return
        }

        if (config.worktree === undefined) {
          const exists = yield* fs.exists(config.cwd).pipe(Effect.orElseSucceed(() => false))
          if (!exists) {
            yield* Effect.logWarning('resumePane: pane working directory no longer exists', {
              paneId,
              cwd: config.cwd
            })
            yield* emitErrored(paneId, onEvent, `Working directory no longer exists: ${config.cwd}`)
            return
          }
        }

        const request: PaneCreationRequest = {
          paneId,
          sourceCwd: config.worktree?.sourceRepo ?? config.cwd,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
          permissionMode: config.permissionMode,
          worktreePath: config.worktree?.path,
          resume: sessionId
        }

        const result = yield* supervisor
          .openPane(
            request,
            onEvent,
            (newSessionId) => recordSessionId(paneId, newSessionId),
            (mode) => recordPermissionMode(paneId, mode, onEvent)
          )
          .pipe(Effect.either)

        if (Either.isLeft(result)) {
          yield* Effect.logError('Failed to resume pane', { paneId, cause: result.left })
          yield* emitErrored(paneId, onEvent, `Failed to resume pane: ${String(result.left)}`)
        }
      })

      return {
        getTree,
        split,
        createPane,
        setThinkingLevel,
        setPermissionMode,
        close,
        getPaneHistory,
        resumePane
      }
    })
  )
