import type { ConversationMessage } from '@shared/domain/pane'
import type { PaneNode } from '@shared/domain/pane-tree'
import {
  type ChooseDirectoryResult,
  ClosePane,
  CreatePane,
  type DiaApi,
  FocusPane,
  InterruptPane,
  type IpcEvent,
  LayoutChanged,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  RewindToCheckpoint,
  SendMessage,
  SetPermissionMode,
  SetThinkingLevel,
  SplitPane
} from '@shared/ipc/contract'
import type { DiaRpcs, EventFrame } from '@shared/ipc/rpc'
import { Duration, Effect, Ref, Schedule, Stream } from 'effect'
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
 * (`onHistoryReloadRequested`), and the layout is re-fetched after every reconnect because layout
 * changes are never replayed.
 */
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

    const refreshLayoutAfterReconnect = Effect.gen(function* () {
      const reconnecting = yield* Ref.getAndSet(connectedBefore, true)
      if (!reconnecting) return
      const client = yield* deps.client
      const tree = yield* client.GetInitialLayout()
      dispatch(LayoutChanged.make({ tree }))
    }).pipe(Effect.catch((error) => Effect.sync(() => deps.warn('Layout refresh failed', error))))

    const subscribeOnce = Effect.gen(function* () {
      const client = yield* deps.client
      yield* refreshLayoutAfterReconnect
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
      clearOverride: (name) => query((client) => client.ClearPluginOverride({ name }))
    },
    sendMessage: (paneId, text) =>
      command('SendMessage', (client, commandId) =>
        client.SendMessage({ ...SendMessage.make({ paneId, text }), commandId })
      ),
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
    splitPane: (paneId, direction) =>
      command('SplitPane', (client, commandId) =>
        client.SplitPane({ ...SplitPane.make({ paneId, direction }), commandId })
      ),
    closePane: (paneId) =>
      command('ClosePane', (client, commandId) =>
        client.ClosePane({ ...ClosePane.make({ paneId }), commandId })
      ),
    createPane: (paneId, cwd, model, thinkingLevel, permissionMode, useWorktree) =>
      command('CreatePane', (client, commandId) =>
        client.CreatePane({
          ...CreatePane.make({ paneId, cwd, model, thinkingLevel, permissionMode, useWorktree }),
          commandId
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
    resolvePlanReview: (paneId, requestId, approved) =>
      command('ResolvePlanReview', (client, id) =>
        client.ResolvePlanReview({
          ...ResolvePlanReview.make({ paneId, requestId, approved }),
          commandId: id
        })
      ),
    focusPane: (paneId) =>
      command('FocusPane', (client, commandId) =>
        client.FocusPane({ ...FocusPane.make({ paneId }), commandId })
      ),
    interrupt: (paneId) =>
      command('InterruptPane', (client, commandId) =>
        client.InterruptPane({ ...InterruptPane.make({ paneId }), commandId })
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
    getInitialLayout: (): Promise<PaneNode> => query((client) => client.GetInitialLayout()),
    getPaneHistory: (paneId): Promise<ReadonlyArray<ConversationMessage>> =>
      query((client) => client.GetPaneHistory({ paneId })),
    chooseDirectory: (): Promise<ChooseDirectoryResult> =>
      query((client) => client.GetLastDirectory())
        .then((last) => deps.pickDirectory(last))
        .then((chosen) =>
          chosen === null ? null : query((client) => client.RecordChosenDirectory({ path: chosen }))
        ),
    getTheme: () => query((client) => client.GetTheme()),
    setTheme: (theme) => query((client) => client.SetTheme({ theme })),
    onHistoryReloadRequested: (listener) => {
      reloadListeners.add(listener)
      return () => reloadListeners.delete(listener)
    },
    onMessageAppended: (listener) => subscribeTo('PaneMessageAppended', listener),
    onLayoutChanged: (listener) => subscribeTo('LayoutChanged', listener),
    onPaneCreateFailed: (listener) => subscribeTo('PaneCreateFailed', listener),
    onAttentionChanged: (listener) => subscribeTo('PaneAttentionChanged', listener),
    onPermissionRequested: (listener) => subscribeTo('PanePermissionRequested', listener),
    onQuestionRequested: (listener) => subscribeTo('PaneQuestionRequested', listener),
    onPlanReviewRequested: (listener) => subscribeTo('PanePlanReviewRequested', listener),
    onSlashCommandsWarming: (listener) => subscribeTo('PaneSlashCommandsWarming', listener),
    onSlashCommandsAvailable: (listener) => subscribeTo('PaneSlashCommandsAvailable', listener),
    onConversationCompacted: (listener) => subscribeTo('PaneConversationCompacted', listener),
    onConversationReset: (listener) => subscribeTo('PaneConversationReset', listener),
    onCheckpointAvailable: (listener) => subscribeTo('PaneCheckpointAvailable', listener),
    onRewoundToCheckpoint: (listener) => subscribeTo('PaneRewoundToCheckpoint', listener),
    onAssistantTextDelta: (listener) => subscribeTo('PaneAssistantTextDelta', listener),
    onAssistantThinkingDelta: (listener) => subscribeTo('PaneAssistantThinkingDelta', listener),
    onToolCallStarted: (listener) => subscribeTo('PaneToolCallStarted', listener),
    onToolCallCompleted: (listener) => subscribeTo('PaneToolCallCompleted', listener)
  }
}
