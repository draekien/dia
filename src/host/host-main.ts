import { randomBytes } from 'node:crypto'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's http server is what NodeHttpServer wraps.
import { createServer } from 'node:http'
import { NodeFileSystem, NodeHttpServer, NodePath, NodeServices } from '@effect/platform-node'
import type { PaneId } from '@shared/domain/pane-tree'
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
import { HttpServer } from 'effect/http'
import { makeLoggerLive } from '../main/logger'
import { makeHostServerLive } from './ipc/host-server'
import { DiaRpcHandlersLive } from './ipc/rpc-handlers'
import { HostPlugins, makeHostPluginsLive } from './plugins/host-plugins'
import { makePluginSourcesLive } from './plugins/plugin-sources'
import { makeCommandDeduperLive } from './services/command-deduper'
import { makeEventHubLive } from './services/event-hub'
import { GitOpsServiceLive } from './services/git-ops-service'
import { PaneSupervisor, PaneSupervisorLive, SessionFactoryLive } from './services/pane-supervisor'
import { makePaneWorkspaceLive } from './services/pane-workspace'
import { makePersistenceServiceLive } from './services/persistence'
import { makeSettingsStoreLive } from './services/settings-store'
import { TranscriptReaderLive } from './services/transcript-reader'

const INITIAL_PANE_ID: PaneId = '00000000-0000-0000-0000-000000000001'

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
  const gitOps = Layer.provide(GitOpsServiceLive, NodeServices.layer)
  const settings = Layer.provide(makeSettingsStoreLive(init.userDataPath), NodeServices.layer)
  const eventHub = makeEventHubLive()
  const pluginSources = Layer.provide(
    makePluginSourcesLive(init.pluginsRoot),
    Layer.mergeAll(settings, NodeFileSystem.layer, NodePath.layer)
  )
  const hostPlugins = Layer.provide(
    makeHostPluginsLive(init.pluginApiPath),
    Layer.mergeAll(pluginSources, eventHub, NodeFileSystem.layer, NodePath.layer)
  )
  const sessionFactory = Layer.provide(SessionFactoryLive, Layer.merge(hostPlugins, pluginSources))
  const supervisor = Layer.provide(PaneSupervisorLive, Layer.merge(sessionFactory, gitOps))
  const persistence = Layer.provide(
    makePersistenceServiceLive(init.userDataPath),
    NodeServices.layer
  )
  const workspace = Layer.provide(
    makePaneWorkspaceLive(INITIAL_PANE_ID, init.worktreesRoot),
    Layer.mergeAll(
      supervisor,
      persistence,
      TranscriptReaderLive,
      NodeFileSystem.layer,
      NodePath.layer
    )
  )
  const state = Layer.mergeAll(
    supervisor,
    workspace,
    settings,
    eventHub,
    pluginSources,
    hostPlugins,
    makeCommandDeduperLive(),
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

    const token = randomBytes(32).toString('hex')
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
