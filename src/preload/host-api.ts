import { ActivityInfo, ActivityNotFound } from '@shared/domain/background-activity'
import type { ModelPreferencesSnapshot } from '@shared/domain/model-preferences'
import { RegisterProjectError, type RegisterProjectRefusal } from '@shared/domain/project'
import {
  ActivitiesChanged,
  type ActivityNotFoundJson,
  type AdapterStatusSnapshotJson,
  AgentSummariesReplaced,
  type DiaApi,
  type IpcEvent,
  type LastVisibleModelJson,
  type ModelCatalogSnapshotJson,
  MoveProject,
  type PluginCallResultJson,
  type PluginSubscriptionEndJson,
  RenameTab,
  SelectTab,
  SetModel,
  SetPermissionMode,
  SetThinkingLevel,
  SetTranscriptWidth,
  WorkspaceChanged
} from '@shared/ipc/contract'
import type { DiaRpcs, EventFrame, PaneEventFrame } from '@shared/ipc/rpc'
import {
  PluginCallError,
  PluginSubscriptionDone,
  PluginSubscriptionEnd,
  PluginSubscriptionFailure
} from '@shared/plugin/messages'
import { Duration, Effect, Fiber, Ref, Schedule, Schema, Stream } from 'effect'
import type { RpcClient, RpcClientError } from 'effect/rpc'

/** The typed client of the Host's RPC surface. */
export type DiaRpcClient = RpcClient.FromGroup<typeof DiaRpcs, RpcClientError.RpcClientError>

/**
 * The part of `window.dia` that talks to the Host. Window-level operations (title bar, DevTools,
 * updater, version) are not part of it.
 */
export type HostApi = Omit<
  DiaApi,
  | 'setTitleBarOverlay'
  | 'getAppVersion'
  | 'getUpdateStatus'
  | 'checkForUpdates'
  | 'installUpdate'
  | 'toggleDevTools'
  | 'onUpdateStatusChanged'
  | 'revealPath'
  | 'pickFile'
  | 'pathForFile'
>

/**
 * Everything {@link makeHostApi} needs from its environment. `client` resolves once the Host
 * connection is open. `pickDirectory` opens
 * the native directory picker starting at the given path. `newRequestId` mints the identifier
 * that makes a resent command idempotent, and the id of a plugin call. `warn` reports failures that have no caller to throw
 * to.
 */
export interface HostApiDeps {
  readonly client: Effect.Effect<DiaRpcClient>
  readonly pickDirectory: (defaultPath: string | null) => Promise<string | null>
  readonly newRequestId: () => string
  readonly warn: (message: string, detail?: unknown) => void
}

/** How long a command or query keeps being resent while the Host connection is down. */
export const RESEND_WINDOW = Duration.seconds(30)

const RUNS_PLUGIN = 'dia-runs'
const RESEND_INTERVAL = Duration.millis(500)
const RESUBSCRIBE_INTERVAL = Duration.seconds(1)

const resendSchedule = Schedule.spaced(RESEND_INTERVAL).pipe(
  Schedule.upTo({ duration: RESEND_WINDOW })
)

/**
 * Builds the Host-backed half of `window.dia` over an RPC client and starts consuming the Host's
 * event stream in the background.
 *
 * Commands return immediately and are resent with the same `commandId` while the connection is
 * down, for up to {@link RESEND_WINDOW}; the Host applies each `commandId` once. A plugin call is
 * resent the same way under one call id, marked as a resend after its first attempt. The event
 * stream resumes after a dropped connection from the last sequence number received per pane;
 * when the Host cannot replay what was missed it asks the renderer to reload that pane's history
 * (`onHistoryReloadRequested`). Workspace and agent-summary changes are never replayed, so after
 * every reconnect the workspace and all summaries are read again and delivered as
 * `WorkspaceChanged` and `AgentSummariesReplaced`.
 *
 * Values cross `contextBridge`, which drops prototypes, so every result is plain data: a typed
 * error (`registerProject`) resolves in its encoded form (`archiveTab`, `deleteTab` and `unarchiveTab` resolve its reason), and only a lost connection is retried. `removeProject` is not retried: it rejects when the connection drops.
 *
 * The session, model, adapter and usage-limit members are calls to the `dia-runs` plugin, with the
 * pane id as the run id. A session command keeps its call id across resends, so `dia-runs` applies
 * it once.
 */
const encodeRefusal = Schema.encodeSync(RegisterProjectError)
const encodeActivities = Schema.encodeSync(Schema.Array(ActivityInfo))
const encodeActivityNotFound = Schema.encodeSync(ActivityNotFound)
const encodePluginCallError = Schema.encodeSync(PluginCallError)
const encodeSubscriptionEnd = Schema.encodeSync(PluginSubscriptionEnd)
const isPluginCallError = Schema.is(PluginCallError)
const untilServed = (error: unknown): boolean =>
  !isPluginCallError(error) || error._tag === 'PluginNotServing'

export const makeHostApi = (deps: HostApiDeps): HostApi => {
  const reloadListeners = new Set<(paneId: string) => void>()
  const eventListeners = new Set<(event: IpcEvent) => void>()
  const paneFrameListeners = new Set<(frame: PaneEventFrame) => void>()
  const cursors = Ref.makeUnsafe<Record<string, number>>({})

  const dispatch = (event: IpcEvent): void => {
    for (const listener of eventListeners) listener(event)
  }

  const command = (
    name: string,
    send: (client: DiaRpcClient, commandId: string) => Effect.Effect<unknown, unknown>
  ): void => {
    const commandId = deps.newRequestId()
    void Effect.runPromise(
      deps.client.pipe(
        Effect.flatMap((client) => send(client, commandId)),
        Effect.retry(resendSchedule),
        Effect.catch((error) => Effect.sync(() => deps.warn(`Command ${name} failed`, error)))
      )
    )
  }

  const query = <A>(call: (client: DiaRpcClient) => Effect.Effect<A, unknown>): Promise<A> =>
    Effect.runPromise(
      deps.client.pipe(Effect.flatMap(call), Effect.retry(resendSchedule), Effect.orDie)
    )

  const consume = Effect.gen(function* () {
    const connectedBefore = yield* Ref.make(false)

    const handleFrame = (frame: EventFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (frame._tag === 'PaneEvent') {
          yield* Ref.update(cursors, (current) => ({ ...current, [frame.paneId]: frame.seq }))
          for (const listener of paneFrameListeners) listener(frame)
          dispatch(frame.event)
        } else if (frame._tag === 'GlobalEvent') {
          dispatch(frame.event)
        } else {
          yield* Ref.update(cursors, (current) => {
            const { [frame.paneId]: _dropped, ...rest } = current
            return rest
          })
          for (const listener of reloadListeners) listener(frame.paneId)
        }
      })

    const refreshWorkspace = Effect.gen(function* () {
      const client = yield* deps.client
      const [workspace, summaries] = yield* Effect.all(
        [client.GetWorkspace(), client.GetAgentSummaries()],
        { concurrency: 'unbounded' }
      )
      dispatch(WorkspaceChanged.make({ workspace }))
      dispatch(AgentSummariesReplaced.make({ summaries }))
    }).pipe(
      Effect.catch((error) => Effect.sync(() => deps.warn('Workspace refresh failed', error)))
    )

    const refreshAfterReconnect = Effect.gen(function* () {
      const reconnecting = yield* Ref.getAndSet(connectedBefore, true)
      if (!reconnecting) return
      dispatch(ActivitiesChanged.make({}))
      yield* refreshWorkspace
    })

    const subscribeOnce = Effect.gen(function* () {
      const client = yield* deps.client
      yield* refreshAfterReconnect
      const current = yield* Ref.get(cursors)
      yield* client.SubscribeEvents({ cursors: current }).pipe(Stream.runForEach(handleFrame))
    })

    yield* subscribeOnce.pipe(
      Effect.catch((error) =>
        Effect.sync(() => deps.warn('Host event stream dropped; resubscribing', error))
      ),
      Effect.repeat(Schedule.spaced(RESUBSCRIBE_INTERVAL))
    )
  })

  void Effect.runFork(consume)

  const subscribePlugin = (
    plugin: string,
    tag: string,
    payload: unknown,
    onValue: (value: unknown) => void,
    onEnd: (end: PluginSubscriptionEndJson) => void
  ): (() => void) => {
    const subscribeOnce = Effect.gen(function* () {
      const client = yield* deps.client
      yield* client
        .SubscribePlugin({ plugin, tag, payload })
        .pipe(Stream.runForEach((value) => Effect.sync(() => onValue(value))))
      return PluginSubscriptionDone.make({})
    }).pipe(
      Effect.catchTag(
        ['PluginNotServing', 'PluginCallInvalid', 'PluginCallFailed'],
        (error): Effect.Effect<PluginSubscriptionEnd> =>
          Effect.succeed(PluginSubscriptionFailure.make({ error }))
      ),
      Effect.tapError((error) =>
        Effect.sync(() =>
          deps.warn('Plugin subscription dropped; resubscribing', { plugin, tag, error })
        )
      ),
      Effect.retry(Schedule.spaced(RESUBSCRIBE_INTERVAL)),
      Effect.flatMap((end) => Effect.sync(() => onEnd(encodeSubscriptionEnd(end))))
    )
    const fiber = Effect.runFork(subscribeOnce)
    return () => void Effect.runFork(Fiber.interrupt(fiber))
  }

  const callRuns = (tag: string, payload: unknown) => {
    const id = deps.newRequestId()
    let sent = false
    return deps.client.pipe(
      Effect.flatMap((client) =>
        Effect.suspend(() => {
          const call = { id, resent: sent }
          sent = true
          return client.CallPlugin({ plugin: RUNS_PLUGIN, tag, payload, call })
        })
      ),
      Effect.retry({
        schedule: resendSchedule,
        while: untilServed
      })
    )
  }

  const runCommand = (tag: string, payload: Record<string, unknown>): void => {
    void Effect.runPromise(
      callRuns(tag, payload).pipe(
        Effect.catch((error) => Effect.sync(() => deps.warn(`Command ${tag} failed`, error)))
      )
    )
  }

  const runQuery = <A>(tag: string, payload: Record<string, unknown> = {}): Promise<A> =>
    Effect.runPromise(
      callRuns(tag, payload).pipe(
        Effect.map((value) => value as A),
        Effect.orDie
      )
    )

  const followRuns =
    <A>(tag: string) =>
    (listener: (value: A) => void): (() => void) => {
      const follow = Effect.gen(function* () {
        const client = yield* deps.client
        yield* client
          .SubscribePlugin({ plugin: RUNS_PLUGIN, tag, payload: {} })
          .pipe(Stream.runForEach((value) => Effect.sync(() => listener(value as A))))
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => deps.warn(`Following ${tag} dropped; resubscribing`, error))
        ),
        Effect.retry({ schedule: Schedule.spaced(RESUBSCRIBE_INTERVAL), while: untilServed }),
        Effect.catch((error) => Effect.sync(() => deps.warn(`Stopped following ${tag}`, error)))
      )
      const fiber = Effect.runFork(follow)
      return () => void Effect.runFork(Fiber.interrupt(fiber))
    }

  const subscribeTo = <E extends IpcEvent['_tag']>(
    tag: E,
    listener: (event: Extract<IpcEvent, { _tag: E }>) => void
  ): (() => void) => {
    const wrapped = (event: IpcEvent): void => {
      if (event._tag === tag) listener(event as Extract<IpcEvent, { _tag: E }>)
    }
    eventListeners.add(wrapped)
    return () => eventListeners.delete(wrapped)
  }

  return {
    plugins: {
      list: () => query((client) => client.ListPlugins()),
      load: (name) => query((client) => client.LoadPlugin({ name })),
      unload: (name) => query((client) => client.UnloadPlugin({ name })),
      setOverride: (name, directory) =>
        query((client) => client.SetPluginOverride({ name, directory })),
      clearOverride: (name) => query((client) => client.ClearPluginOverride({ name })),
      onStatusChanged: (listener) => subscribeTo('PluginStatusChanged', listener),
      call: (plugin, tag, payload) => {
        const id = deps.newRequestId()
        let sent = false
        return query((client) =>
          Effect.suspend(() => {
            const call = { id, resent: sent }
            sent = true
            return client.CallPlugin({ plugin, tag, payload, call })
          }).pipe(
            Effect.map((value): PluginCallResultJson => ({ _tag: 'Success', value })),
            Effect.catchTag(
              ['PluginNotServing', 'PluginCallInvalid', 'PluginCallFailed'],
              (error): Effect.Effect<PluginCallResultJson> =>
                Effect.succeed({ _tag: 'Failure', error: encodePluginCallError(error) })
            )
          )
        )
      },
      subscribe: subscribePlugin
    },
    models: {
      get: () => runQuery<ModelCatalogSnapshotJson>('GetModels'),
      refresh: () => runQuery<void>('RefreshModels'),
      onChanged: followRuns<ModelCatalogSnapshotJson>('FollowModels')
    },
    adapter: {
      getStatus: () => runQuery<AdapterStatusSnapshotJson>('GetAdapterStatus'),
      checkHealth: () => runQuery<void>('CheckAdapterHealth'),
      setInstallPath: (path) => runQuery<void>('SetInstallPath', { path }),
      onStatusChanged: followRuns<AdapterStatusSnapshotJson>('FollowAdapterStatus'),
      getPreferences: () => runQuery<ModelPreferencesSnapshot>('GetModelPreferences'),
      setModelPreference: (model, preference) =>
        Effect.runPromise(
          callRuns('SetModelPreference', { model, preference }).pipe(
            Effect.as<LastVisibleModelJson | null>(null),
            Effect.catchTag('PluginCallFailed', (failure) =>
              Effect.succeed(failure.error as LastVisibleModelJson)
            ),
            Effect.orDie
          )
        ),
      setDefaults: (defaults) => runQuery<void>('SetAgentDefaults', { defaults }),
      onPreferencesChanged: followRuns<ModelPreferencesSnapshot>('FollowModelPreferences'),
      getDisabledPermissionModes: (cwd) => runQuery('GetDisabledPermissionModes', { cwd }),
      getAttachmentTypes: () => runQuery('GetAttachmentTypes')
    },
    activities: {
      list: () => query((client) => client.ListActivities().pipe(Effect.map(encodeActivities))),
      run: (plugin, id) =>
        query((client) =>
          client.RunActivity({ plugin, id }).pipe(
            Effect.as<ActivityNotFoundJson | null>(null),
            Effect.catchTag('ActivityNotFound', (error) =>
              Effect.succeed(encodeActivityNotFound(error))
            )
          )
        ),
      onChanged: (listener) => subscribeTo('ActivitiesChanged', () => listener())
    },
    metaRepo: {
      getState: () => query((client) => client.GetMetaRepo()),
      setRemote: (url) => query((client) => client.SetMetaRemote({ url })),
      push: () => query((client) => client.PushMetaRepo())
    },
    workspaceProblems: {
      list: () =>
        query((client) =>
          client.ListWorkspaceProblems().pipe(
            Effect.catchTag('WorkspaceProblemError', (error) =>
              Effect.as(
                Effect.logWarning('Could not list the workspace problems', {
                  reason: error.reason
                }),
                []
              )
            )
          )
        ),
      deleteRow: (row) =>
        query((client) =>
          client.DeleteUnreadableRow(row).pipe(
            Effect.as<string | null>(null),
            Effect.catchTag('WorkspaceProblemError', (error) => Effect.succeed(error.reason))
          )
        ),
      resolveImportConflict: (agentId, resolution) =>
        query((client) =>
          client.ResolveImportConflict({ agentId, resolution }).pipe(
            Effect.as<string | null>(null),
            Effect.catchTag('WorkspaceProblemError', (error) => Effect.succeed(error.reason))
          )
        )
    },
    sendMessage: (paneId, text, mode, attachments) =>
      runCommand('SendMessage', {
        runId: paneId,
        text,
        mode,
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
      }),
    editQueuedMessage: (paneId, messageId, text, attachments) =>
      runCommand('EditQueuedMessage', {
        runId: paneId,
        messageId,
        text,
        ...(attachments !== undefined ? { attachments } : {})
      }),
    listProjectEntries: (cwd) => query((client) => client.ListProjectEntries({ cwd })),
    removeQueuedMessage: (paneId, messageId) =>
      runCommand('RemoveQueuedMessage', { runId: paneId, messageId }),
    sendQueuedMessageNow: (paneId, messageId) =>
      runCommand('SendQueuedMessageNow', { runId: paneId, messageId }),
    resolvePermission: (paneId, requestId, response) =>
      runCommand('ResolvePermission', { runId: paneId, requestId, response }),
    resolveQuestion: (paneId, requestId, response) =>
      runCommand('ResolveQuestion', { runId: paneId, requestId, response }),
    setThinkingLevel: (paneId, level) =>
      command('SetThinkingLevel', (client, commandId) =>
        client.SetThinkingLevel({ ...SetThinkingLevel.make({ paneId, level }), commandId })
      ),
    setPermissionMode: (paneId, mode) =>
      command('SetPermissionMode', (client, commandId) =>
        client.SetPermissionMode({ ...SetPermissionMode.make({ paneId, mode }), commandId })
      ),
    setModel: (paneId, model) =>
      command('SetModel', (client, commandId) =>
        client.SetModel({ ...SetModel.make({ paneId, model }), commandId })
      ),
    resolvePlanReview: (paneId, requestId, approved) =>
      runCommand('ResolvePlanReview', { runId: paneId, requestId, approved }),
    interrupt: (paneId) => runCommand('InterruptRun', { runId: paneId }),
    resumeParkedAgent: (paneId) => runCommand('ResumeParkedRun', { runId: paneId }),
    rewindToCheckpoint: (paneId, messageUuid, resumeAnchorUuid) =>
      runCommand('RewindToCheckpoint', {
        runId: paneId,
        messageUuid,
        ...(resumeAnchorUuid !== undefined ? { resumeAnchorUuid } : {})
      }),
    getWorkspace: () => query((client) => client.GetWorkspace()),
    registerProject: (projectId, directory) =>
      query((client) =>
        client.RegisterProject({ projectId, directory }).pipe(
          Effect.as<RegisterProjectRefusal | null>(null),
          Effect.catchTags({
            ProjectAlreadyRegisteredError: (error) => Effect.succeed(encodeRefusal(error)),
            DirectoryNotFoundError: (error) => Effect.succeed(encodeRefusal(error)),
            StoredProjectUnreadableError: (error) => Effect.succeed(encodeRefusal(error))
          })
        )
      ),
    moveProject: (projectId, toIndex) =>
      command('MoveProject', (client, commandId) =>
        client.MoveProject({ ...MoveProject.make({ projectId, toIndex }), commandId })
      ),
    removeProject: (projectId, force, onProgress) =>
      Effect.runPromise(
        deps.client.pipe(
          Effect.flatMap((client) =>
            client
              .RemoveProject({ projectId, force })
              .pipe(Stream.runForEach((progress) => Effect.sync(() => onProgress(progress))))
          ),
          Effect.catchTag('ProjectNotFoundError', (error) =>
            Effect.logInfo('The project to remove was already gone', {
              projectId: error.projectId
            })
          )
        )
      ),
    createTab: (request) =>
      command('CreateTab', (client, commandId) => client.CreateTab({ ...request, commandId })),
    archiveTab: (paneId) =>
      query((client) =>
        client.ArchiveTab({ paneId }).pipe(
          Effect.as<string | null>(null),
          Effect.catchTag('WorktreeNotRemovedError', (error) => Effect.succeed(error.reason))
        )
      ),
    deleteTab: (paneId) =>
      query((client) =>
        client.DeleteTab({ paneId }).pipe(
          Effect.as<string | null>(null),
          Effect.catchTag('WorktreeNotRemovedError', (error) => Effect.succeed(error.reason))
        )
      ),
    unarchiveTab: (paneId) =>
      query((client) =>
        client.UnarchiveTab({ paneId }).pipe(
          Effect.as<string | null>(null),
          Effect.catchTag('WorktreeNotRestoredError', (error) => Effect.succeed(error.reason))
        )
      ),
    renameTab: (paneId, name) =>
      command('RenameTab', (client, commandId) =>
        client.RenameTab({ ...RenameTab.make({ paneId, name }), commandId })
      ),
    selectTab: (paneId) =>
      command('SelectTab', (client, commandId) =>
        client.SelectTab({
          ...SelectTab.make({ paneId }),
          commandId
        })
      ),
    getAgentSummaries: () => query((client) => client.GetAgentSummaries()),
    getTranscriptWidth: () => query((client) => client.GetTranscriptWidth()),
    setTranscriptWidth: (width) =>
      command('SetTranscriptWidth', (client, commandId) =>
        client.SetTranscriptWidth({ ...SetTranscriptWidth.make({ width }), commandId })
      ),
    getPaneChat: (paneId) =>
      query((client) =>
        client
          .GetPaneChat({ paneId })
          .pipe(
            Effect.tap((snapshot) =>
              Ref.update(cursors, (current) =>
                (current[paneId] ?? 0) >= snapshot.seq
                  ? current
                  : { ...current, [paneId]: snapshot.seq }
              )
            )
          )
      ),
    pickDirectory: () => deps.pickDirectory(null),
    getTheme: () => query((client) => client.GetTheme()),
    setTheme: (theme) => query((client) => client.SetTheme({ theme })),
    getSendMode: () => query((client) => client.GetSendMode()),
    setSendMode: (mode) => query((client) => client.SetSendMode({ mode })),
    getUsageLimitResume: () => runQuery('GetUsageLimitResume'),
    setUsageLimitResume: (mode) => runQuery<void>('SetUsageLimitResume', { mode }),
    onHistoryReloadRequested: (listener) => {
      reloadListeners.add(listener)
      return () => reloadListeners.delete(listener)
    },
    onPaneEvent: (listener) => {
      paneFrameListeners.add(listener)
      return () => paneFrameListeners.delete(listener)
    },
    onWorkspaceChanged: (listener) => subscribeTo('WorkspaceChanged', listener),
    onAgentSummaryChanged: (listener) => subscribeTo('AgentSummaryChanged', listener),
    onAgentSummariesReplaced: (listener) => subscribeTo('AgentSummariesReplaced', listener),
    onPaneCreateFailed: (listener) => subscribeTo('PaneCreateFailed', listener),
    onAttentionChanged: (listener) => subscribeTo('PaneAttentionChanged', listener),
    onRewoundToCheckpoint: (listener) => subscribeTo('PaneRewoundToCheckpoint', listener),
    onRewindFailed: (listener) => subscribeTo('PaneRewindFailed', listener)
  }
}
