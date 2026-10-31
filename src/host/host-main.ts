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
import { AgentSummariesLive } from './services/agent-summaries'
import { BackgroundActivitiesLive } from './services/background-activities'
import { makeCommandDeduperLive } from './services/command-deduper'
import { makeHostDatabaseLive } from './services/database'
import { makeEventHubLive } from './services/event-hub'
import { ModelCatalogFeed, ModelCatalogFeedLive } from './services/model-catalog-feed'
import { ModelPreferencesLive } from './services/model-preferences'
import { PaneSupervisor, PaneSupervisorLive, SessionFactoryLive } from './services/pane-supervisor'
import { makePaneWorkspaceLive } from './services/pane-workspace'
import { makePersistenceServiceLive } from './services/persistence'
import { makeSettingsStoreLive } from './services/settings-store'
import { TranscriptReaderLive } from './services/transcript-reader'
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

const buildHostLayer = (init: HostInit, token: string) => {
  const settings = Layer.provide(makeSettingsStoreLive(init.userDataPath), NodeServices.layer)
  const eventHub = makeEventHubLive()
  const pluginSources = Layer.provide(
    makePluginSourcesLive(init.pluginsRoot),
    Layer.mergeAll(settings, NodeFileSystem.layer, NodePath.layer)
  )
  const backgroundActivities = Layer.provide(BackgroundActivitiesLive, eventHub)
  const hostPlugins = Layer.provide(
    makeHostPluginsLive(init.pluginApiPath, init.userDataPath),
    Layer.mergeAll(
      pluginSources,
      eventHub,
      backgroundActivities,
      NodeFileSystem.layer,
      NodePath.layer
    )
  )
  const sessionFactory = Layer.provide(SessionFactoryLive, Layer.merge(hostPlugins, pluginSources))
  const supervisor = Layer.provide(
    PaneSupervisorLive,
    Layer.mergeAll(sessionFactory, hostPlugins, settings)
  )
  const persistence = Layer.provide(
    makePersistenceServiceLive(init.userDataPath),
    NodeServices.layer
  )
  const hostDatabase = makeHostDatabaseLive(init.userDataPath)
  const workspaceStore = Layer.provide(
    makeWorkspaceStoreLive(init.userDataPath),
    Layer.merge(hostDatabase, NodeServices.layer)
  )
  const workspace = Layer.provide(
    makePaneWorkspaceLive(init.worktreesRoot),
    Layer.mergeAll(
      supervisor,
      workspaceStore,
      Layer.provide(TranscriptReaderLive, hostPlugins),
      eventHub,
      hostPlugins,
      NodeFileSystem.layer,
      NodePath.layer
    )
  )
  const summaries = Layer.provide(
    AgentSummariesLive,
    Layer.mergeAll(workspace, persistence, eventHub)
  )
  const modelCatalog = Layer.provide(ModelCatalogFeedLive, Layer.merge(hostPlugins, eventHub))
  const adapterStatus = Layer.provide(AdapterStatusFeedLive, Layer.merge(hostPlugins, eventHub))
  const modelPreferences = Layer.provide(
    ModelPreferencesLive,
    Layer.mergeAll(settings, modelCatalog, hostPlugins, eventHub)
  )
  const state = Layer.mergeAll(
    supervisor,
    workspace,
    summaries,
    settings,
    eventHub,
    pluginSources,
    hostPlugins,
    backgroundActivities,
    modelCatalog,
    adapterStatus,
    modelPreferences,
    makeCommandDeduperLive(),
    hostDatabase,
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
      }
      yield* Effect.logInfo('Host shutting down')
      yield* supervisor.closeAll()
      yield* Scope.close(hostScope, Exit.void)
      yield* post(HostShutdownComplete.make({}))
    }).pipe(Effect.provideContext(context))
  })
)
