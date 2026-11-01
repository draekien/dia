import {
  agentNameFromBranch,
  agentNameFromTitle,
  generateAgentName
} from '@shared/domain/agent-name'
import { Errored } from '@shared/domain/attention'
import {
  type ConversationMessage,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_LEVEL,
  type PaneId,
  type PermissionMode,
  type SessionId,
  type ThinkingLevel
} from '@shared/domain/pane'
import {
  type AgentName,
  type CreateTabRequest,
  DirectoryNotFoundError,
  EMPTY_WORKSPACE,
  type Project,
  type ProjectAlreadyRegisteredError,
  type ProjectId,
  ProjectNotFoundError,
  type Tab,
  TabNotFoundError,
  type Workspace,
  WorktreeNotRemovedError,
  WorktreeUnavailableError
} from '@shared/domain/project'
import {
  ProjectRemoved,
  type RemovalItem,
  type RemovalProgress,
  Removed,
  RemoveFailed,
  Removing,
  removalItemsOf
} from '@shared/domain/project-removal'
import { Uuid } from '@shared/domain/uuid'
import * as WorkspaceOps from '@shared/domain/workspace'
import { type IpcEvent, PaneAttentionChanged, WorkspaceChanged } from '@shared/ipc/contract'
import {
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Result,
  Semaphore,
  Stream,
  SubscriptionRef
} from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import type { DiscoveredSession } from '../session/agent-backend'
import { EventHub } from './event-hub'
import { type PaneCreationRequest, PaneSupervisor } from './pane-supervisor'
import { probeProject } from './project-directory'
import { TranscriptReader } from './transcript-reader'
import { WorkspaceFeed } from './workspace-feed'
import { WorkspaceStore } from './workspace-store'
import {
  resolveGitOps,
  type WorktreeCreateError,
  type WorktreeReattachError
} from './worktrees-seam'

type OnEvent = (event: IpcEvent) => Effect.Effect<void>

/**
 * Service tag for the pane workspace: owns the registered projects, their tabs, the project
 * order and the visible tab, persists them, and starts and stops the agent session behind each
 * tab through the {@link PaneSupervisor}. Every change it makes is published as
 * `WorkspaceChanged` on the {@link EventHub} before the call returns, so clients read workspace
 * state only from `getWorkspace` and that event.
 */
export class PaneWorkspace extends Context.Service<
  PaneWorkspace,
  {
    readonly getWorkspace: Effect.Effect<Workspace>
    /**
     * Registers `directory` as project `projectId` at the end of the project order, and imports
     * each conversation the agent adapter holds for the directory as a tab that has not started,
     * in the order the conversations began. The visible tab does not change. Succeeds unchanged
     * when the same id already registered it. Fails when another project registered
     * the directory, or when it is not an existing directory.
     */
    readonly registerProject: (
      projectId: ProjectId,
      directory: string
    ) => Effect.Effect<void, ProjectAlreadyRegisteredError | DirectoryNotFoundError>
    /** Moves a project to `toIndex` in the project order. */
    readonly moveProject: (
      projectId: ProjectId,
      toIndex: number
    ) => Effect.Effect<void, ProjectNotFoundError>
    /**
     * Removes a project, streaming each step: every agent's session is stopped, then its
     * worktree and transcripts are deleted. The project is dropped once every item is removed;
     * when an item fails it stays, and a later call retries. With `force` the project is dropped
     * after its agents stop, and worktrees and transcripts are left on disk. The project
     * directory is never touched. While it runs, the project's tabs cannot be created, shown or
     * started.
     */
    readonly removeProject: (
      projectId: ProjectId,
      force: boolean
    ) => Stream.Stream<RemovalProgress, ProjectNotFoundError>
    /**
     * Starts an agent as a new tab of a project and shows it. A tab without a name is named
     * after its worktree branch, else gets a generated name. Fails before starting anything when
     * the project is unknown or being removed, or when a worktree is asked of a project that is
     * not a git repo.
     */
    readonly createTab: (
      request: CreateTabRequest,
      onEvent: OnEvent
    ) => Effect.Effect<
      void,
      ProjectNotFoundError | WorktreeUnavailableError | WorktreeCreateError | WorktreeReattachError
    >
    readonly renameTab: (paneId: PaneId, name: AgentName) => Effect.Effect<void, TabNotFoundError>
    /**
     * Archives a tab: stops its session, removes its worktree, and marks it archived. Its branch
     * and transcripts stay. Fails with `WorktreeNotRemovedError`, leaving the tab unarchived with
     * its session stopped, when the worktree is still on disk afterwards; a later call retries.
     * Fails with `TabNotFoundError` for an unknown tab, one whose project is being removed, or
     * one already being archived or deleted.
     */
    readonly archiveTab: (
      paneId: PaneId
    ) => Effect.Effect<void, TabNotFoundError | WorktreeNotRemovedError>
    /**
     * Deletes a tab: stops its session, removes its worktree, and drops the tab with every record
     * dia keeps of it. Its branch and transcripts stay with git and the agent harness (ADR-0046).
     * When it was the visible tab, another tab is shown. Fails as {@link archiveTab} does, leaving
     * the tab in place.
     */
    readonly deleteTab: (
      paneId: PaneId
    ) => Effect.Effect<void, TabNotFoundError | WorktreeNotRemovedError>
    /**
     * Shows the tab of `paneId`, or no tab for `null`, and resumes the shown tab's recorded
     * session when it is not running and the tab is not archived. Fails for an unknown tab, or one
     * whose project is being removed or which is being archived or deleted.
     */
    readonly selectTab: (
      paneId: PaneId | null,
      onEvent: OnEvent
    ) => Effect.Effect<void, TabNotFoundError>
    /** Stores a tab's thinking level and, when its session runs, applies it from the next turn. */
    readonly setThinkingLevel: (
      paneId: PaneId,
      level: ThinkingLevel
    ) => Effect.Effect<void, TabNotFoundError>
    /** Stores a tab's permission mode and, when its session runs, applies it at once. */
    readonly setPermissionMode: (
      paneId: PaneId,
      mode: PermissionMode
    ) => Effect.Effect<void, TabNotFoundError>
    /** Stores a tab's model and, when its session runs, makes its next turn use it. */
    readonly setModel: (paneId: PaneId, model: string) => Effect.Effect<void, TabNotFoundError>
    readonly getPaneHistory: (paneId: PaneId) => Effect.Effect<ReadonlyArray<ConversationMessage>>
    /**
     * Resumes a cold tab's Agent SDK session, streaming its events through `onEvent`. A no-op
     * when the session already runs, when the tab is unknown or its project is being removed, or
     * when it has no recorded session. Handles its own failures -- a gone non-worktree working
     * directory, or a spawn/reattach failure -- by logging and emitting an `Errored` attention
     * event rather than failing the effect.
     */
    readonly resumePane: (paneId: PaneId, onEvent: OnEvent) => Effect.Effect<void>
    /**
     * Guarantees a tab has a running session before a command that needs one, so the command is
     * not dropped: continues the recorded session, or starts a fresh conversation in the tab's
     * working directory. A no-op when the session already runs, or the tab is unknown or its
     * project is being removed. Failures are handled as in {@link resumePane}.
     */
    readonly ensureLive: (paneId: PaneId, onEvent: OnEvent) => Effect.Effect<void>
  }
>()('PaneWorkspace') {}

const WORKTREES_PLUGIN_NOT_LOADED = 'Load the worktrees plugin to remove this worktree'

/**
 * Builds the live {@link PaneWorkspace} layer. On construction it loads the persisted workspace
 * (sessions stay cold -- no processes are spawned here) and shows the first tab when none is
 * visible; with nothing persisted it starts empty. `worktreesRoot` is the base directory under
 * which tab worktrees are created. Requires {@link PaneSupervisor}, {@link WorkspaceStore},
 * {@link TranscriptReader}, {@link EventHub}, {@link HostPlugins} (for the worktree and agent
 * backend services used to remove a project), {@link WorkspaceFeed} (which it keeps current),
 * `FileSystem`, `Path` and `Crypto`.
 */
export const makePaneWorkspaceLive = (worktreesRoot: string) =>
  Layer.effect(
    PaneWorkspace,
    Effect.gen(function* () {
      const supervisor = yield* PaneSupervisor
      const store = yield* WorkspaceStore
      const transcriptReader = yield* TranscriptReader
      const hub = yield* EventHub
      const plugins = yield* HostPlugins
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto

      const persisted = yield* store.load
      const initial = Option.match(persisted, {
        onNone: () => EMPTY_WORKSPACE,
        onSome: WorkspaceOps.withDefaultVisibleTab
      })

      const workspaceRef = yield* WorkspaceFeed
      yield* SubscriptionRef.set(workspaceRef, initial)
      const removingRef = yield* Ref.make<ReadonlySet<ProjectId>>(new Set())
      const retiringRef = yield* Ref.make<ReadonlySet<PaneId>>(new Set())
      const pendingSessions = new Map<PaneId, SessionId>()
      const mutationLock = yield* Semaphore.make(1)
      const sessionStartLock = yield* Semaphore.make(1)

      const save = (workspace: Workspace) =>
        store
          .save(workspace)
          .pipe(Effect.catch((cause) => Effect.logError('Failed to persist workspace', { cause })))

      const mutate = <E>(
        operation: string,
        apply: (
          workspace: Workspace,
          removing: ReadonlySet<ProjectId>
        ) => Result.Result<Workspace, E>
      ): Effect.Effect<void, E> =>
        mutationLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(workspaceRef)
            const next = apply(current, yield* Ref.get(removingRef))
            if (Result.isFailure(next)) {
              yield* Effect.logDebug('Workspace change refused', { operation, error: next.failure })
              return yield* Effect.fail(next.failure)
            }
            if (next.success === current) return
            yield* SubscriptionRef.set(workspaceRef, next.success)
            yield* save(next.success)
            yield* hub.publish(WorkspaceChanged.make({ workspace: next.success }))
            yield* Effect.logDebug('Workspace changed', { operation })
          })
        )

      const projectOfTab = (paneId: PaneId) =>
        Effect.map(SubscriptionRef.get(workspaceRef), (workspace) =>
          Result.map(WorkspaceOps.tabOf(workspace, paneId), (found) => found.project.projectId)
        )

      const isRemovingTab = (paneId: PaneId) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(retiringRef)).has(paneId)) return true
          const projectId = yield* projectOfTab(paneId)
          const removing = yield* Ref.get(removingRef)
          return Result.isSuccess(projectId) && removing.has(projectId.success)
        })

      const recordSessionId = (paneId: PaneId, sessionId: Option.Option<SessionId>) =>
        mutate<never>('recordSession', (workspace) => {
          const next = WorkspaceOps.recordSession(workspace, paneId, sessionId)
          if (Result.isSuccess(next)) return Result.succeed(next.success)
          Option.match(sessionId, {
            onNone: () => pendingSessions.delete(paneId),
            onSome: (id) => pendingSessions.set(paneId, id)
          })
          return Result.succeed(workspace)
        }).pipe(
          Effect.andThen(
            Effect.logDebug(
              'Recorded or cleared a session id, or held it for a tab not added yet',
              {
                paneId,
                cleared: Option.isNone(sessionId)
              }
            )
          )
        )

      const recordPermissionMode = (paneId: PaneId, mode: PermissionMode) =>
        mutate('recordPermissionMode', (workspace) =>
          WorkspaceOps.updateTabConfig(workspace, paneId, { permissionMode: mode })
        ).pipe(
          Effect.catchTag('TabNotFoundError', () =>
            Effect.logWarning('Received permission mode for an unknown tab', { paneId })
          )
        )

      const getWorkspace = SubscriptionRef.get(workspaceRef)

      const importedTab = Effect.fn('PaneWorkspace.importedTab')(function* (
        project: Project,
        session: DiscoveredSession
      ) {
        const paneId = Uuid.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie))
        const name = yield* Option.match(agentNameFromTitle(session.title), {
          onSome: Effect.succeed,
          onNone: () => generateAgentName
        })
        return {
          name,
          config: {
            paneId,
            cwd: project.directory,
            model: session.model,
            thinkingLevel: DEFAULT_THINKING_LEVEL,
            permissionMode: DEFAULT_PERMISSION_MODE
          },
          sessionId: session.sessionId,
          archived: false
        } satisfies Tab
      })

      const registerProject = Effect.fn('PaneWorkspace.registerProject')(function* (
        projectId: ProjectId,
        directory: string
      ) {
        const info = yield* fs.stat(directory).pipe(Effect.option)
        if (Option.isNone(info) || info.value.type !== 'Directory') {
          return yield* new DirectoryNotFoundError({ directory })
        }
        const project = yield* probeProject(projectId, directory).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path)
        )
        const sessions = yield* transcriptReader.discoverSessions(project.directory)
        const tabs = yield* Effect.forEach(
          [...sessions].sort((a, b) => a.startedAt - b.startedAt),
          (session) => importedTab(project, session)
        )
        yield* mutate('registerProject', (workspace) =>
          WorkspaceOps.addProject(workspace, project, tabs)
        )
        yield* Effect.logInfo('Registered project', { projectId, directory, imported: tabs.length })
      })

      const moveProject = (projectId: ProjectId, toIndex: number) =>
        mutate('moveProject', (workspace) =>
          WorkspaceOps.moveProject(workspace, projectId, toIndex)
        )

      const removeWorktree = Effect.fn('PaneWorkspace.removeWorktree')(function* (
        paneId: PaneId,
        worktree: NonNullable<Tab['config']['worktree']>
      ) {
        const stillThere = () => fs.exists(worktree.path).pipe(Effect.orElseSucceed(() => true))
        if (!(yield* stillThere())) return Option.none<string>()
        const gitOps = yield* resolveGitOps(plugins)
        if (Option.isNone(gitOps)) return Option.some(WORKTREES_PLUGIN_NOT_LOADED)
        const removal = yield* gitOps.value.removeWorktree(worktree, paneId).pipe(Effect.result)
        if (!(yield* stillThere())) return Option.none<string>()
        return Option.some(
          Result.isFailure(removal)
            ? `Could not remove the worktree: ${String(removal.failure.cause)}`
            : 'The worktree directory is still on disk'
        )
      })

      const removeProjectItems = Effect.fn('PaneWorkspace.removeProjectItems')(function* (
        tabs: ReadonlyArray<Tab>,
        force: boolean,
        emit: (progress: RemovalProgress) => Effect.Effect<void>
      ) {
        let failures = 0
        const removeItem = (item: RemovalItem, run: Effect.Effect<Option.Option<string>>) =>
          Effect.gen(function* () {
            yield* emit(Removing.make({ item }))
            const failure = yield* run
            if (Option.isSome(failure)) {
              failures += 1
              yield* Effect.logWarning('Failed to remove a project item', {
                item,
                reason: failure.value
              })
              yield* emit(RemoveFailed.make({ item, reason: failure.value }))
            } else {
              yield* emit(Removed.make({ item }))
            }
          })

        const removalOf = (tab: Tab, item: RemovalItem): Effect.Effect<Option.Option<string>> => {
          switch (item._tag) {
            case 'AgentItem':
              return supervisor.closePane(item.paneId).pipe(Effect.as(Option.none<string>()))
            case 'WorktreeItem':
              return tab.config.worktree === undefined
                ? Effect.succeed(Option.none<string>())
                : removeWorktree(tab.config.paneId, tab.config.worktree)
          }
        }

        for (const tab of tabs) {
          for (const item of removalItemsOf(tab)) {
            if (force && item._tag !== 'AgentItem') continue
            yield* removeItem(item, removalOf(tab, item))
          }
        }
        return failures
      })

      const markRemoving = (projectId: ProjectId) =>
        mutationLock.withPermits(1)(
          Effect.gen(function* () {
            const workspace = yield* SubscriptionRef.get(workspaceRef)
            const removing = yield* Ref.get(removingRef)
            const entry = workspace.projects.find(
              (candidate) => candidate.project.projectId === projectId
            )
            if (entry === undefined || removing.has(projectId)) {
              return yield* new ProjectNotFoundError({ projectId })
            }
            yield* Ref.set(removingRef, new Set([...removing, projectId]))
            return entry
          })
        )

      const clearRemoving = (projectId: ProjectId) =>
        Ref.update(removingRef, (removing) => {
          const next = new Set(removing)
          next.delete(projectId)
          return next
        })

      const runRemoval = Effect.fn('PaneWorkspace.runRemoval')(function* (
        projectId: ProjectId,
        force: boolean,
        emit: (progress: RemovalProgress) => Effect.Effect<void>
      ) {
        const entry = yield* markRemoving(projectId)
        yield* Effect.gen(function* () {
          yield* mutate('moveVisibleTabOff', (workspace) =>
            WorkspaceOps.moveVisibleTabOff(workspace, projectId)
          )
          const failures = yield* removeProjectItems(entry.tabs, force, emit)
          if (failures > 0 && !force) {
            yield* Effect.logWarning('Project removal left items on disk', { projectId, failures })
            return
          }
          yield* mutate('removeProject', (workspace) =>
            WorkspaceOps.removeProject(workspace, projectId)
          )
          yield* emit(ProjectRemoved.make({}))
          yield* Effect.logInfo('Removed project', { projectId, force })
        }).pipe(Effect.ensuring(clearRemoving(projectId)))
      })

      const removeProject = (projectId: ProjectId, force: boolean) =>
        Stream.callback<RemovalProgress, ProjectNotFoundError>((queue) =>
          runRemoval(projectId, force, (progress) =>
            Queue.offer(queue, progress).pipe(Effect.asVoid)
          ).pipe(
            Effect.matchEffect({
              onFailure: (error) => Queue.fail(queue, error),
              onSuccess: () => Queue.end(queue)
            })
          )
        )

      const nameForTab = (request: CreateTabRequest, branch: string | undefined) =>
        request.name !== null
          ? Effect.succeed(request.name)
          : Option.match(agentNameFromBranch(branch), {
              onSome: Effect.succeed,
              onNone: () => generateAgentName
            })

      const createTab = Effect.fn('PaneWorkspace.createTab')(function* (
        request: CreateTabRequest,
        onEvent: OnEvent
      ) {
        const { projectId, paneId } = request
        const workspace = yield* SubscriptionRef.get(workspaceRef)
        const entry = workspace.projects.find(
          (candidate) => candidate.project.projectId === projectId
        )
        if (entry === undefined || (yield* Ref.get(removingRef)).has(projectId)) {
          return yield* new ProjectNotFoundError({ projectId })
        }
        if (request.useWorktree && !entry.project.isGitRepo) {
          return yield* new WorktreeUnavailableError({ projectId })
        }

        const { config } = yield* supervisor.openPane(
          {
            paneId,
            sourceCwd: entry.project.directory,
            model: request.model,
            thinkingLevel: request.thinkingLevel,
            permissionMode: request.permissionMode,
            worktree: request.useWorktree ? { _tag: 'Create', worktreesRoot } : undefined
          },
          onEvent,
          (sessionId) => recordSessionId(paneId, sessionId),
          (mode) => recordPermissionMode(paneId, mode)
        )

        const name = yield* nameForTab(request, config.worktree?.branch)
        yield* mutate('addTab', (current, removing) => {
          if (removing.has(projectId)) return Result.fail(new ProjectNotFoundError({ projectId }))
          const sessionId = pendingSessions.get(paneId)
          pendingSessions.delete(paneId)
          const tab: Tab =
            sessionId === undefined
              ? { name, config, archived: false }
              : { name, config, sessionId, archived: false }
          return WorkspaceOps.addTab(current, projectId, tab)
        }).pipe(Effect.tapError(() => supervisor.closePane(paneId)))
        yield* Effect.logInfo('Created tab', { projectId, paneId, name })
      })

      const renameTab = (paneId: PaneId, name: AgentName) =>
        mutate('renameTab', (workspace) => WorkspaceOps.renameTab(workspace, paneId, name))

      const markRetiring = (paneId: PaneId) =>
        mutationLock.withPermits(1)(
          Effect.gen(function* () {
            const found = WorkspaceOps.tabOf(yield* SubscriptionRef.get(workspaceRef), paneId)
            if (Result.isFailure(found) || (yield* isRemovingTab(paneId))) {
              return yield* new TabNotFoundError({ paneId })
            }
            yield* Ref.update(retiringRef, (retiring) => new Set([...retiring, paneId]))
            return found.success.tab
          })
        )

      const clearRetiring = (paneId: PaneId) =>
        Ref.update(retiringRef, (retiring) => {
          const next = new Set(retiring)
          next.delete(paneId)
          return next
        })

      const retireTab = Effect.fn('PaneWorkspace.retireTab')(function* (
        paneId: PaneId,
        operation: 'archiveTab' | 'deleteTab',
        apply: (workspace: Workspace, paneId: PaneId) => Result.Result<Workspace, TabNotFoundError>
      ) {
        const tab = yield* markRetiring(paneId)
        yield* Effect.gen(function* () {
          yield* sessionStartLock.withPermits(1)(supervisor.closePane(paneId))
          const worktree = tab.config.worktree
          if (worktree !== undefined) {
            const failure = yield* removeWorktree(paneId, worktree)
            if (Option.isSome(failure)) {
              yield* Effect.logWarning('Left a tab in place; its worktree was not removed', {
                paneId,
                operation,
                reason: failure.value
              })
              return yield* new WorktreeNotRemovedError({
                paneId,
                path: worktree.path,
                reason: failure.value
              })
            }
          }
          yield* mutate(operation, (workspace) => apply(workspace, paneId))
          yield* Effect.logInfo(operation === 'archiveTab' ? 'Archived tab' : 'Deleted tab', {
            paneId,
            removedWorktree: worktree?.path
          })
        }).pipe(Effect.ensuring(clearRetiring(paneId)))
      })

      const archiveTab = (paneId: PaneId) =>
        retireTab(paneId, 'archiveTab', WorkspaceOps.archiveTab)

      const deleteTab = (paneId: PaneId) => retireTab(paneId, 'deleteTab', WorkspaceOps.deleteTab)

      const setThinkingLevel = Effect.fn('PaneWorkspace.setThinkingLevel')(function* (
        paneId: PaneId,
        level: ThinkingLevel
      ) {
        yield* mutate('setThinkingLevel', (workspace) =>
          WorkspaceOps.updateTabConfig(workspace, paneId, { thinkingLevel: level })
        )
        const handle = yield* supervisor.getHandle(paneId)
        if (Option.isSome(handle)) yield* handle.value.setThinkingLevel(level)
      })

      const setPermissionMode = Effect.fn('PaneWorkspace.setPermissionMode')(function* (
        paneId: PaneId,
        mode: PermissionMode
      ) {
        yield* mutate('setPermissionMode', (workspace) =>
          WorkspaceOps.updateTabConfig(workspace, paneId, { permissionMode: mode })
        )
        const handle = yield* supervisor.getHandle(paneId)
        if (Option.isSome(handle)) yield* handle.value.setPermissionMode(mode)
      })

      const setModel = Effect.fn('PaneWorkspace.setModel')(function* (
        paneId: PaneId,
        model: string
      ) {
        yield* mutate('setModel', (workspace) =>
          WorkspaceOps.updateTabConfig(workspace, paneId, { model })
        )
        const handle = yield* supervisor.getHandle(paneId)
        if (Option.isSome(handle)) yield* handle.value.setModel(model)
      })

      const getPaneHistory = Effect.fn('PaneWorkspace.getPaneHistory')(function* (paneId: PaneId) {
        const found = WorkspaceOps.tabOf(yield* SubscriptionRef.get(workspaceRef), paneId)
        if (Result.isFailure(found)) return []
        const { sessionId, config } = found.success.tab
        if (sessionId === undefined) return []
        return yield* transcriptReader.readHistory(sessionId, config.cwd)
      })

      const emitErrored = (paneId: PaneId, onEvent: OnEvent, message: string) =>
        onEvent(
          PaneAttentionChanged.make({ paneId, attention: Errored.make({ error: { message } }) })
        )

      const startPaneSession = Effect.fn('PaneWorkspace.startPaneSession')(function* (
        paneId: PaneId,
        onEvent: OnEvent,
        startFresh: boolean
      ) {
        const existing = yield* supervisor.getHandle(paneId)
        if (Option.isSome(existing)) return

        if (yield* isRemovingTab(paneId)) {
          yield* Effect.logWarning('Did not start a tab whose project is being removed', { paneId })
          return
        }
        const found = WorkspaceOps.tabOf(yield* SubscriptionRef.get(workspaceRef), paneId)
        if (Result.isFailure(found)) {
          yield* Effect.logWarning('Did not start an unknown tab', { paneId })
          return
        }

        const { config, sessionId, archived } = found.success.tab
        if (archived) {
          yield* Effect.logDebug('Did not start an archived tab', { paneId })
          return
        }
        if (sessionId === undefined && !startFresh) {
          yield* Effect.logDebug('resumePane skipped; tab has no session to resume', { paneId })
          return
        }

        if (config.worktree === undefined) {
          const exists = yield* fs.exists(config.cwd).pipe(Effect.orElseSucceed(() => false))
          if (!exists) {
            yield* Effect.logWarning('resumePane: tab working directory no longer exists', {
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
          worktree:
            config.worktree !== undefined ? { _tag: 'Reattach', info: config.worktree } : undefined,
          resume: sessionId
        }

        const result = yield* supervisor
          .openPane(
            request,
            onEvent,
            (newSessionId) => recordSessionId(paneId, newSessionId),
            (mode) => recordPermissionMode(paneId, mode)
          )
          .pipe(Effect.result)

        if (Result.isFailure(result)) {
          yield* Effect.logError('Failed to resume tab', { paneId, cause: result.failure })
          yield* emitErrored(paneId, onEvent, `Failed to resume pane: ${String(result.failure)}`)
        }
      })

      const resumePane = (paneId: PaneId, onEvent: OnEvent) =>
        sessionStartLock.withPermits(1)(startPaneSession(paneId, onEvent, false))

      const ensureLive = Effect.fn('PaneWorkspace.ensureLive')(function* (
        paneId: PaneId,
        onEvent: OnEvent
      ) {
        const existing = yield* supervisor.getHandle(paneId)
        if (Option.isSome(existing)) return
        yield* sessionStartLock.withPermits(1)(startPaneSession(paneId, onEvent, true))
      })

      const selectTab = Effect.fn('PaneWorkspace.selectTab')(function* (
        paneId: PaneId | null,
        onEvent: OnEvent
      ) {
        if (paneId !== null && (yield* isRemovingTab(paneId))) {
          return yield* new TabNotFoundError({ paneId })
        }
        yield* mutate('selectTab', (workspace) => WorkspaceOps.selectTab(workspace, paneId))
        if (paneId !== null) yield* resumePane(paneId, onEvent)
      })

      return {
        getWorkspace,
        registerProject,
        moveProject,
        removeProject,
        createTab,
        renameTab,
        archiveTab,
        deleteTab,
        selectTab,
        setThinkingLevel,
        setPermissionMode,
        setModel,
        getPaneHistory,
        resumePane,
        ensureLive
      }
    })
  )
