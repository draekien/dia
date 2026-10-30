import { AdapterStatusSnapshot } from '@shared/domain/adapter-status'
import { ActivityInfo, ActivityNotFound } from '@shared/domain/background-activity'
import { ModelCatalogSnapshot } from '@shared/domain/model'
import { LastVisibleModel } from '@shared/domain/model-preferences'
import type { ConversationMessage } from '@shared/domain/pane'
import { RegisterProjectError, type RegisterProjectRefusal } from '@shared/domain/project'
import {
  ActivitiesChanged,
  type ActivityNotFoundJson,
  AdapterStatusChanged,
  AgentSummariesReplaced,
  type DiaApi,
  EditQueuedMessage,
  InterruptPane,
  type IpcEvent,
  type LastVisibleModelJson,
  ModelPreferencesChanged,
  ModelsChanged,
  MoveProject,
  RemoveQueuedMessage,
  RenameTab,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  ResumeParkedAgent,
  RewindToCheckpoint,
  SelectTab,
  SendMessage,
  SetModel,
  SetPermissionMode,
  SetThinkingLevel,
  SetTranscriptWidth,
  WorkspaceChanged
} from '@shared/ipc/contract'
import type { DiaRpcs, EventFrame } from '@shared/ipc/rpc'
import { Duration, Effect, Ref, Schedule, Schema, Stream } from 'effect'
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
>

/**
 * Everything {@link makeHostApi} needs from its environment. `client` resolves once the Host
 * connection is open. `pickDirectory` opens
 * the native directory picker starting at the given path. `newRequestId` mints the identifier
 * that makes a resent command idempotent. `warn` reports failures that have no caller to throw
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
 * down, for up to {@link RESEND_WINDOW}; the Host applies each `commandId` once. The event
 * stream resumes after a dropped connection from the last sequence number received per pane;
 * when the Host cannot replay what was missed it asks the renderer to reload that pane's history
 * (`onHistoryReloadRequested`). Workspace and agent-summary changes are never replayed, so after
 * every reconnect the workspace and all summaries are read again and delivered as
 * `WorkspaceChanged` and `AgentSummariesReplaced`.
 *
 * Values cross `contextBridge`, which drops prototypes, so every result is plain data: a typed
 * error (`registerProject`) resolves in its encoded form, and only a lost connection is retried. `removeProject` is not retried: it rejects when the connection drops.
 */
const encodeRefusal = Schema.encodeSync(RegisterProjectError)
const encodeSnapshot = Schema.encodeSync(ModelCatalogSnapshot)
const encodeActivities = Schema.encodeSync(Schema.Array(ActivityInfo))
const encodeActivityNotFound = Schema.encodeSync(ActivityNotFound)
const encodeAdapterStatus = Schema.encodeSync(AdapterStatusSnapshot)
const encodeLastVisibleModel = Schema.encodeSync(LastVisibleModel)

export const makeHostApi = (deps: HostApiDeps): HostApi => {
  const reloadListeners = new Set<(paneId: string) => void>()
  const eventListeners = new Set<(event: IpcEvent) => void>()

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
    const cursors = yield* Ref.make<Record<string, number>>({})
    const connectedBefore = yield* Ref.make(false)

    const handleFrame = (frame: EventFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (frame._tag === 'PaneEvent') {
          yield* Ref.update(cursors, (current) => ({ ...current, [frame.paneId]: frame.seq }))
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

    const refreshCatalogs = Effect.gen(function* () {
      const client = yield* deps.client
      const [snapshot, status, preferences] = yield* Effect.all(
        [client.GetModels(), client.GetAdapterStatus(), client.GetModelPreferences()],
        { concurrency: 'unbounded' }
      )
      dispatch(ModelsChanged.make({ snapshot }))
      dispatch(AdapterStatusChanged.make({ snapshot: status }))
      dispatch(ModelPreferencesChanged.make({ snapshot: preferences }))
    }).pipe(
      Effect.catch((error) => Effect.sync(() => deps.warn('Model list refresh failed', error)))
    )

    const refreshAfterReconnect = Effect.gen(function* () {
      const reconnecting = yield* Ref.getAndSet(connectedBefore, true)
      if (!reconnecting) return
      dispatch(ActivitiesChanged.make({}))
      yield* Effect.all([refreshWorkspace, refreshCatalogs], { concurrency: 'unbounded' })
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
      onStatusChanged: (listener) => subscribeTo('PluginStatusChanged', listener)
    },
    models: {
      get: () => query((client) => client.GetModels().pipe(Effect.map(encodeSnapshot))),
      refresh: () => query((client) => client.RefreshModels()),
      onChanged: (listener) =>
        subscribeTo('ModelsChanged', (event) => listener(encodeSnapshot(event.snapshot)))
    },
    adapter: {
      getStatus: () =>
        query((client) => client.GetAdapterStatus().pipe(Effect.map(encodeAdapterStatus))),
      checkHealth: () => query((client) => client.CheckAdapterHealth()),
      setInstallPath: (path) => query((client) => client.SetInstallPath({ path })),
      onStatusChanged: (listener) =>
        subscribeTo('AdapterStatusChanged', (event) =>
          listener(encodeAdapterStatus(event.snapshot))
        ),
      getPreferences: () => query((client) => client.GetModelPreferences()),
      setModelPreference: (model, preference) =>
        query((client) =>
          client.SetModelPreference({ model, preference }).pipe(
            Effect.as<LastVisibleModelJson | null>(null),
            Effect.catchTag('LastVisibleModel', (error) =>
              Effect.succeed(encodeLastVisibleModel(error))
            )
          )
        ),
      setDefaults: (defaults) => query((client) => client.SetAgentDefaults({ defaults })),
      onPreferencesChanged: (listener) =>
        subscribeTo('ModelPreferencesChanged', (event) => listener(event.snapshot)),
      getDisabledPermissionModes: (cwd) =>
        query((client) => client.GetDisabledPermissionModes({ cwd }))
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
    sendMessage: (paneId, text, mode) =>
      command('SendMessage', (client, commandId) =>
        client.SendMessage({ ...SendMessage.make({ paneId, text, mode }), commandId })
      ),
    editQueuedMessage: (paneId, messageId, text) =>
      command('EditQueuedMessage', (client, commandId) =>
        client.EditQueuedMessage({
          ...EditQueuedMessage.make({ paneId, messageId, text }),
          commandId
        })
      ),
    removeQueuedMessage: (paneId, messageId) =>
      command('RemoveQueuedMessage', (client, commandId) =>
        client.RemoveQueuedMessage({
          ...RemoveQueuedMessage.make({ paneId, messageId }),
          commandId
        })
      ),
    getMessageQueue: (paneId) => query((client) => client.GetMessageQueue({ paneId })),
    resolvePermission: (paneId, requestId, response) =>
      command('ResolvePermission', (client, id) =>
        client.ResolvePermission({
          ...ResolvePermission.make({ paneId, requestId, response }),
          commandId: id
        })
      ),
    resolveQuestion: (paneId, requestId, response) =>
      command('ResolveQuestion', (client, id) =>
        client.ResolveQuestion({
          ...ResolveQuestion.make({ paneId, requestId, response }),
          commandId: id
        })
      ),
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
      command('ResolvePlanReview', (client, id) =>
        client.ResolvePlanReview({
          ...ResolvePlanReview.make({ paneId, requestId, approved }),
          commandId: id
        })
      ),
    interrupt: (paneId) =>
      command('InterruptPane', (client, commandId) =>
        client.InterruptPane({ ...InterruptPane.make({ paneId }), commandId })
      ),
    resumeParkedAgent: (paneId) =>
      command('ResumeParkedAgent', (client, commandId) =>
        client.ResumeParkedAgent({ ...ResumeParkedAgent.make({ paneId }), commandId })
      ),
    rewindToCheckpoint: (paneId, messageUuid, resumeAnchorUuid) =>
      command('RewindToCheckpoint', (client, commandId) =>
        client.RewindToCheckpoint({
          ...RewindToCheckpoint.make({
            paneId,
            messageUuid,
            ...(resumeAnchorUuid !== undefined ? { resumeAnchorUuid } : {})
          }),
          commandId
        })
      ),
    getWorkspace: () => query((client) => client.GetWorkspace()),
    registerProject: (projectId, directory) =>
      query((client) =>
        client.RegisterProject({ projectId, directory }).pipe(
          Effect.as<RegisterProjectRefusal | null>(null),
          Effect.catchTags({
            ProjectAlreadyRegisteredError: (error) => Effect.succeed(encodeRefusal(error)),
            DirectoryNotFoundError: (error) => Effect.succeed(encodeRefusal(error))
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
    getPaneHistory: (paneId): Promise<ReadonlyArray<ConversationMessage>> =>
      query((client) => client.GetPaneHistory({ paneId })),
    pickDirectory: () => deps.pickDirectory(null),
    getTheme: () => query((client) => client.GetTheme()),
    setTheme: (theme) => query((client) => client.SetTheme({ theme })),
    getSendMode: () => query((client) => client.GetSendMode()),
    setSendMode: (mode) => query((client) => client.SetSendMode({ mode })),
    getUsageLimitResume: () => query((client) => client.GetUsageLimitResume()),
    setUsageLimitResume: (mode) => query((client) => client.SetUsageLimitResume({ mode })),
    onHistoryReloadRequested: (listener) => {
      reloadListeners.add(listener)
      return () => reloadListeners.delete(listener)
    },
    onMessageAppended: (listener) => subscribeTo('PaneMessageAppended', listener),
    onWorkspaceChanged: (listener) => subscribeTo('WorkspaceChanged', listener),
    onAgentSummaryChanged: (listener) => subscribeTo('AgentSummaryChanged', listener),
    onAgentSummariesReplaced: (listener) => subscribeTo('AgentSummariesReplaced', listener),
    onPaneCreateFailed: (listener) => subscribeTo('PaneCreateFailed', listener),
    onAttentionChanged: (listener) => subscribeTo('PaneAttentionChanged', listener),
    onPermissionRequested: (listener) => subscribeTo('PanePermissionRequested', listener),
    onQuestionRequested: (listener) => subscribeTo('PaneQuestionRequested', listener),
    onPlanReviewRequested: (listener) => subscribeTo('PanePlanReviewRequested', listener),
    onSlashCommandsWarming: (listener) => subscribeTo('PaneSlashCommandsWarming', listener),
    onSlashCommandsAvailable: (listener) => subscribeTo('PaneSlashCommandsAvailable', listener),
    onConversationCompacted: (listener) => subscribeTo('PaneConversationCompacted', listener),
    onModelChanged: (listener) => subscribeTo('PaneModelChanged', listener),
    onConversationReset: (listener) => subscribeTo('PaneConversationReset', listener),
    onCheckpointAvailable: (listener) => subscribeTo('PaneCheckpointAvailable', listener),
    onRewoundToCheckpoint: (listener) => subscribeTo('PaneRewoundToCheckpoint', listener),
    onMessageQueueChanged: (listener) => subscribeTo('PaneMessageQueueChanged', listener),
    onUserMessagesSent: (listener) => subscribeTo('PaneUserMessagesSent', listener),
    onAssistantTextDelta: (listener) => subscribeTo('PaneAssistantTextDelta', listener),
    onAssistantThinkingDelta: (listener) => subscribeTo('PaneAssistantThinkingDelta', listener),
    onToolCallStarted: (listener) => subscribeTo('PaneToolCallStarted', listener),
    onToolCallCompleted: (listener) => subscribeTo('PaneToolCallCompleted', listener),
    onToolCallUpdated: (listener) => subscribeTo('PaneToolCallUpdated', listener),
    onTurnStatusChanged: (listener) => subscribeTo('PaneTurnStatusChanged', listener),
    onSessionNotice: (listener) => subscribeTo('PaneSessionNotice', listener)
  }
}
