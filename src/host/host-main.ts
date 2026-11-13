// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's http server is what NodeHttpServer wraps.
import { createServer } from 'node:http'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  HostBooted,
  type HostInit,
  HostReady,
  HostShutdownComplete,
  HostToMainMessage,
  MainToHostMessage
} from '@shared/ipc/host-process'
import {
  Context,
  Crypto,
  Effect,
  Exit,
  Layer,
  Queue,
  References,
  Result,
  Schema,
  Scope,
  Stream
} from 'effect'
import { Hex } from 'effect/encoding'
import { HttpServer } from 'effect/http'
import { makeLoggerLive } from '../main/logger'
import { makeHostServerLive } from './ipc/host-server'
import { DiaRpcHandlersLive } from './ipc/rpc-handlers'
import { HostPlugins, makeHostPluginsLive } from './plugins/host-plugins'
import { makePluginSourcesLive } from './plugins/plugin-sources'
import { AdapterStatusFeed, AdapterStatusFeedLive } from './services/adapter-status-feed'
import { AgentEventRecorderLive } from './services/agent-event-recorder'
import { AgentEventStoreLive } from './services/agent-event-store'
import { AgentSummariesLive } from './services/agent-summaries'
import { AppWindow, makeAppWindowLive } from './services/app-window'
import { AttachedSessionsLive, SessionAttacherLive } from './services/attached-sessions'
import { BackgroundActivitiesLive } from './services/background-activities'
import { makeCommandDeduperLive } from './services/command-deduper'
import { makeHostDatabaseLive } from './services/database'
import { EventHub, EventHubLive } from './services/event-hub'
import { ModelCatalogFeed, ModelCatalogFeedLive } from './services/model-catalog-feed'
import { ModelPreferencesLive } from './services/model-preferences'
import { PaneChatProjectionLive } from './services/pane-chat-projection'
import { PaneSupervisor, PaneSupervisorLive, SessionFactoryLive } from './services/pane-supervisor'
import { PaneWorkspace, PaneWorkspaceLive } from './services/pane-workspace'
import { PathMovesLive } from './services/path-moves'
import { makePersistenceServiceLive } from './services/persistence'
import { ProjectEntriesLive } from './services/project-entries'
import { makeSettingsStoreLive } from './services/settings-store'
import { TranscriptReaderLive } from './services/transcript-reader'
import { WorkspaceFeedLive } from './services/workspace-feed'
import { makeWorkspaceProblemsLive } from './services/workspace-problems'
import { makeWorkspaceStoreLive } from './services/workspace-store'

const encodeToMain = Schema.encodeSync(HostToMainMessage)
const decodeFromMain = Schema.decodeUnknownResult(MainToHostMessage)

const parentPort = process.parentPort

const post = (message: HostToMainMessage): Effect.Effect<void> =>
  Effect.sync(() => parentPort.postMessage(encodeToMain(message)))

const mainMessages = Stream.callback<unknown>((queue) =>
  Effect.gen(function* () {
    const listener = (event: { data: unknown }): void => void Queue.offerUnsafe(queue, event.data)
    parentPort.on('message', listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => parentPort.off('message', listener)))
  })
).pipe(
  Stream.mapEffect((raw) =>
    Effect.gen(function* () {
      const decoded = decodeFromMain(raw)
      if (Result.isFailure(decoded)) {
        yield* Effect.logWarning('Dropped malformed message from main', { issue: decoded.failure })
      }
      return decoded
    })
  ),
  Stream.filterMap((decoded) => decoded)
)

const handleMainMessage = Effect.fn('Host.handleMainMessage')(function* (
  message: MainToHostMessage,
  hostScope: Scope.Scope
) {
  switch (message._tag) {
    case 'WindowAttention':
      return yield* (yield* AppWindow).setAttended(message.attended)
    case 'ShowAgent': {
      const hub = yield* EventHub
      yield* Effect.logInfo('Showing an agent from its notification', { paneId: message.paneId })
      yield* (yield* PaneWorkspace).selectTab(message.paneId, hub.publish).pipe(
        Effect.catch((error) =>
          Effect.logWarning('Could not show the agent of a notification', {
            paneId: message.paneId,
            error
          })
        ),
        Effect.forkIn(hostScope)
      )
      return
    }
    default:
      return
  }
})

const buildHostLayer = (init: HostInit, token: string) => {
  const settings = Layer.provide(makeSettingsStoreLive(init.userDataPath), NodeServices.layer)
  const hostDatabase = makeHostDatabaseLive(init.userDataPath)
  const agentEventStore = Layer.provide(AgentEventStoreLive, hostDatabase)
  const pathMoves = Layer.provide(PathMovesLive, hostDatabase)
  const eventHub = Layer.provide(EventHubLive, agentEventStore)
  const appWindow = makeAppWindowLive(post)
  const pluginSources = Layer.provide(
    makePluginSourcesLive(init.pluginsRoot),
    Layer.mergeAll(settings, NodeFileSystem.layer, NodePath.layer)
  )
  const backgroundActivities = Layer.provide(BackgroundActivitiesLive, eventHub)
  const sessionAttacher = SessionAttacherLive
  const hostPlugins = Layer.provide(
    makeHostPluginsLive(init.pluginApiPath, init.userDataPath),
    Layer.mergeAll(
      pluginSources,
      eventHub,
      backgroundActivities,
      WorkspaceFeedLive,
      appWindow,
      sessionAttacher,
      pathMoves,
      NodeFileSystem.layer,
      NodePath.layer
    )
  )
  const sessionFactory = Layer.provide(SessionFactoryLive, Layer.merge(hostPlugins, pluginSources))
  const persistence = Layer.provide(
    makePersistenceServiceLive(init.userDataPath),
    NodeServices.layer
  )
  const workspaceStore = Layer.provide(
    makeWorkspaceStoreLive(init.userDataPath),
    Layer.merge(hostDatabase, NodeServices.layer)
  )
  const transcriptReader = Layer.provide(TranscriptReaderLive, hostPlugins)
  const recorder = Layer.provide(
    AgentEventRecorderLive,
    Layer.mergeAll(agentEventStore, transcriptReader, NodeCrypto.layer)
  )
  const supervisor = Layer.provide(
    PaneSupervisorLive,
    Layer.mergeAll(sessionFactory, hostPlugins, settings, recorder)
  )
  const modelCatalog = Layer.provide(ModelCatalogFeedLive, Layer.merge(hostPlugins, eventHub))
  const paneChats = Layer.provide(
    PaneChatProjectionLive,
    Layer.mergeAll(eventHub, WorkspaceFeedLive, agentEventStore, recorder, modelCatalog)
  )
  const attachedSessions = Layer.provide(
    AttachedSessionsLive,
    Layer.mergeAll(supervisor, paneChats, eventHub, sessionAttacher)
  )
  const workspace = Layer.provide(
    PaneWorkspaceLive,
    Layer.mergeAll(
      supervisor,
      workspaceStore,
      transcriptReader,
      paneChats,
      eventHub,
      agentEventStore,
      hostPlugins,
      pathMoves,
      WorkspaceFeedLive,
      NodeServices.layer
    )
  )
  const workspaceProblems = Layer.provide(
    makeWorkspaceProblemsLive(init.userDataPath),
    Layer.mergeAll(workspace, workspaceStore, NodeServices.layer)
  )
  const summaries = Layer.provide(
    AgentSummariesLive,
    Layer.mergeAll(workspace, persistence, eventHub)
  )
  const adapterStatus = Layer.provide(AdapterStatusFeedLive, Layer.merge(hostPlugins, eventHub))
  const modelPreferences = Layer.provide(
    ModelPreferencesLive,
    Layer.mergeAll(settings, modelCatalog, hostPlugins, eventHub)
  )
  const state = Layer.mergeAll(
    supervisor,
    attachedSessions,
    workspace,
    paneChats,
    workspaceProblems,
    summaries,
    settings,
    eventHub,
    pluginSources,
    hostPlugins,
    backgroundActivities,
    modelCatalog,
    adapterStatus,
    modelPreferences,
    appWindow,
    makeCommandDeduperLive(),
    Layer.provide(ProjectEntriesLive, NodeServices.layer),
    hostDatabase,
    agentEventStore,
    NodeFileSystem.layer,
    NodePath.layer
  )
  const server = Layer.provide(
    makeHostServerLive({ token, allowedOrigins: init.allowedOrigins }),
    DiaRpcHandlersLive
  )
  const httpListener = NodeHttpServer.layer(() => createServer(), {
    host: '127.0.0.1',
    port: 0
  })
  const logging = Layer.mergeAll(
    makeLoggerLive(init.isDev, init.logFilePath),
    Layer.succeed(References.MinimumLogLevel, init.isDev ? 'Debug' : 'Info')
  )
  return server.pipe(
    Layer.provideMerge(state),
    Layer.provideMerge(httpListener),
    Layer.provideMerge(logging)
  )
}

/**
 * The Host process program. Announces itself to main, waits for its {@link HostInit}, starts the
 * pane workspace and the authenticated loopback WebSocket, reports the port and token to main,
 * and then runs until main asks it to shut down. Run it once as the Host's entry point.
 */
export const runHost = Effect.scoped(
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<MainToHostMessage>()
    yield* Stream.runForEach(mainMessages, (message) => Queue.offer(inbox, message)).pipe(
      Effect.forkScoped
    )
    yield* post(HostBooted.make({}))

    const init = yield* Effect.gen(function* () {
      while (true) {
        const message = yield* Queue.take(inbox)
        if (message._tag === 'Init') return message
      }
    })

    const token = yield* Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomBytes(32)).pipe(
      Effect.map(Hex.encode),
      Effect.orDie,
      Effect.provide(NodeCrypto.layer)
    )
    const hostScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(hostScope, Exit.void))
    const context = yield* Layer.buildWithScope(buildHostLayer(init, token), hostScope)
    yield* Effect.gen(function* () {
      const server = Context.get(context, HttpServer.HttpServer)
      const supervisor = Context.get(context, PaneSupervisor)
      const address = server.address
      if (!('port' in address)) {
        return yield* Effect.die(
          new Error(`Host listener bound to ${address._tag}, not a TCP port`)
        )
      }
      const { port } = address
      yield* Effect.logInfo('Host listening', { port })
      yield* Context.get(context, HostPlugins).start()
      yield* Context.get(context, ModelCatalogFeed).start
      yield* Context.get(context, AdapterStatusFeed).start
      yield* post(HostReady.make({ port, token }))

      while (true) {
        const message = yield* Queue.take(inbox)
        if (message._tag === 'Shutdown') break
        yield* handleMainMessage(message, hostScope)
      }
      yield* Effect.logInfo('Host shutting down')
      yield* supervisor.closeAll()
      yield* Scope.close(hostScope, Exit.void)
      yield* post(HostShutdownComplete.make({}))
    }).pipe(Effect.provideContext(context))
  })
)
