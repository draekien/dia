// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test binds a loopback HTTP listener the way the Host does.
import { createServer } from 'node:http'
import { NodeHttpServer, NodeSocket } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { PaneAssistantTextDelta } from '@shared/ipc/contract'
import {
  CLOSE_PROTOCOL_MISMATCH,
  DiaRpcs,
  PROTOCOL_VERSION,
  TOKEN_SUBPROTOCOL_PREFIX,
  VERSION_SUBPROTOCOL_PREFIX
} from '@shared/ipc/rpc'
import { Effect, Layer, Stream } from 'effect'
import { HttpServer } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import WS from 'ws'
import { EventHub, makeEventHubLive } from '../services/event-hub'
import { makeHostServerLive } from './host-server'

const TOKEN = 'a'.repeat(64)
const ORIGIN = 'dia://app'
const PANE_ID = '00000000-0000-0000-0000-00000000000a'

const unused = () => Effect.die(new Error('handler not used by this test'))

const handlersLayer = Layer.unwrap(
  Effect.gen(function* () {
    const hub = yield* EventHub
    return DiaRpcs.toLayer({
      SendMessage: unused,
      ResolvePermission: unused,
      ResolveQuestion: unused,
      ResolvePlanReview: unused,
      CreateTab: unused,
      MoveProject: unused,
      RenameTab: unused,
      SelectTab: unused,
      SetTranscriptWidth: unused,
      SetTranscriptMode: unused,
      SetThinkingLevel: unused,
      SetPermissionMode: unused,
      SetModel: unused,
      GetAdapterStatus: unused,
      CheckAdapterHealth: unused,
      SetInstallPath: unused,
      GetModelPreferences: unused,
      SetModelPreference: unused,
      SetAgentDefaults: unused,
      GetDisabledPermissionModes: unused,
      InterruptPane: unused,
      RewindToCheckpoint: unused,
      EditQueuedMessage: unused,
      RemoveQueuedMessage: unused,
      GetMessageQueue: unused,
      GetSendMode: unused,
      SetSendMode: unused,
      GetWorkspace: unused,
      RegisterProject: unused,
      RemoveProject: unused,
      GetAgentSummaries: unused,
      GetTranscriptWidth: unused,
      GetTranscriptMode: unused,
      GetPaneHistory: unused,
      GetTheme: () => Effect.succeed('dark' as const),
      SetTheme: unused,
      ListPlugins: unused,
      LoadPlugin: unused,
      UnloadPlugin: unused,
      SetPluginOverride: unused,
      ClearPluginOverride: unused,
      GetModels: unused,
      RefreshModels: unused,
      ListActivities: unused,
      RunActivity: unused,
      SubscribeEvents: ({ cursors }) => hub.subscribe(cursors)
    })
  })
)

const serverLayer = makeHostServerLive({ token: TOKEN, allowedOrigins: [ORIGIN] }).pipe(
  Layer.provide(handlersLayer),
  Layer.provideMerge(makeEventHubLive()),
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { host: '127.0.0.1', port: 0 }))
)

interface ClientOptions {
  readonly token?: string
  readonly version?: number
  readonly origin?: string
}

const connect = (options: ClientOptions) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    if (!('port' in address)) return yield* Effect.die(new Error('no TCP port'))
    const protocols = [
      `${TOKEN_SUBPROTOCOL_PREFIX}${options.token ?? TOKEN}`,
      `${VERSION_SUBPROTOCOL_PREFIX}${options.version ?? PROTOCOL_VERSION}`
    ]
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(`ws://127.0.0.1:${address.port}`, {
          protocols,
          headers: { Origin: options.origin ?? ORIGIN }
        })
      ),
      Layer.provide(NodeSocket.layerWebSocketConstructor),
      Layer.provide(RpcSerialization.layerJson)
    )
    const context = yield* Layer.build(protocol)
    return yield* RpcClient.make(DiaRpcs).pipe(Effect.provideContext(context))
  })

describe('Host server', () => {
  it.live('answers an RPC from a client that presents the token, origin and version', () =>
    Effect.gen(function* () {
      const client = yield* connect({})

      const theme = yield* client.GetTheme()

      assert.strictEqual(theme, 'dark')
    }).pipe(Effect.scoped, Effect.provide(serverLayer))
  )

  it.live('replays buffered events to a client that subscribes with a cursor', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(PaneAssistantTextDelta.make({ paneId: PANE_ID, text: 'hello' }))
      const client = yield* connect({})

      const frames = yield* client
        .SubscribeEvents({ cursors: { [PANE_ID]: 0 } })
        .pipe(Stream.take(1), Stream.runCollect)

      assert.deepStrictEqual(frames, [
        {
          _tag: 'PaneEvent',
          paneId: PANE_ID,
          seq: 1,
          event: { _tag: 'PaneAssistantTextDelta', paneId: PANE_ID, text: 'hello' }
        }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer))
  )

  it.live('refuses a client that presents the wrong token', () =>
    Effect.gen(function* () {
      const client = yield* connect({ token: 'b'.repeat(64) })

      const result = yield* client.GetTheme().pipe(Effect.result)

      assert.isTrue(result._tag === 'Failure')
    }).pipe(Effect.scoped, Effect.provide(serverLayer))
  )

  it.live('refuses a client whose origin is not allowed', () =>
    Effect.gen(function* () {
      const client = yield* connect({ origin: 'http://evil.example' })

      const result = yield* client.GetTheme().pipe(Effect.result)

      assert.isTrue(result._tag === 'Failure')
    }).pipe(Effect.scoped, Effect.provide(serverLayer))
  )

  it.live('accepts a client of another protocol version and closes it with the mismatch code', () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      if (!('port' in address)) return yield* Effect.die(new Error('no TCP port'))

      const closeCode = yield* Effect.callback<number>((resume) => {
        const ws = new WS(
          `ws://127.0.0.1:${address.port}`,
          [
            `${TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`,
            `${VERSION_SUBPROTOCOL_PREFIX}${PROTOCOL_VERSION}.1`
          ],
          { headers: { Origin: ORIGIN } }
        )
        ws.on('close', (code) => resume(Effect.succeed(code)))
        ws.on('error', (e) => resume(Effect.die(e)))
      })

      assert.strictEqual(closeCode, CLOSE_PROTOCOL_MISMATCH)
    }).pipe(Effect.scoped, Effect.provide(serverLayer))
  )
})
