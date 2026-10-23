import {
  CLOSE_PROTOCOL_MISMATCH,
  DiaRpcs,
  PROTOCOL_VERSION,
  TOKEN_SUBPROTOCOL_PREFIX,
  VERSION_SUBPROTOCOL_PREFIX
} from '@shared/ipc/rpc'
import { Effect, Fiber, Layer, type Scope } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { Socket } from 'effect/socket'

/**
 * What the Host's WebSocket listener requires of a client: the `token` it must present as the
 * subprotocol `dia.token.<token>`, and the `allowedOrigins` an upgrade's `Origin` header must be
 * one of.
 */
export interface HostServerOptions {
  readonly token: string
  readonly allowedOrigins: ReadonlyArray<string>
}

const offeredSubprotocols = (header: string | undefined): ReadonlyArray<string> =>
  (header ?? '').split(',').map((protocol) => protocol.trim())

const offeredVersion = (offered: ReadonlyArray<string>): number | undefined => {
  const entry = offered.find((protocol) => protocol.startsWith(VERSION_SUBPROTOCOL_PREFIX))
  return entry === undefined ? undefined : Number(entry.slice(VERSION_SUBPROTOCOL_PREFIX.length))
}

const handleUpgrade = (
  options: HostServerOptions,
  accept: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const origin = request.headers.origin
    if (origin === undefined || !options.allowedOrigins.includes(origin)) {
      yield* Effect.logWarning('Refused WebSocket upgrade from a disallowed origin', { origin })
      return HttpServerResponse.text('origin not allowed', { status: 403 })
    }

    const offered = offeredSubprotocols(request.headers['sec-websocket-protocol'])
    if (!offered.includes(`${TOKEN_SUBPROTOCOL_PREFIX}${options.token}`)) {
      yield* Effect.logWarning('Refused WebSocket upgrade with a missing or wrong token')
      return HttpServerResponse.text('missing or wrong token', { status: 401 })
    }

    const version = offeredVersion(offered)
    if (version !== PROTOCOL_VERSION) {
      yield* Effect.logWarning('Closing WebSocket whose client speaks another protocol version', {
        clientVersion: version,
        hostVersion: PROTOCOL_VERSION
      })
      const socket = yield* Effect.orDie(request.upgrade)
      const reader = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const { pull } = yield* socket.reader
          while (true) yield* pull
        }).pipe(Effect.ignore)
      )
      const writer = yield* socket.writer
      yield* writer.write(
        new Socket.CloseEvent(
          CLOSE_PROTOCOL_MISMATCH,
          `protocol version mismatch: host ${PROTOCOL_VERSION}, client ${version ?? 'unknown'}`
        )
      )
      yield* Fiber.join(reader)
      return HttpServerResponse.empty()
    }

    return yield* accept
  })

/**
 * Serves {@link DiaRpcs} over a WebSocket on the surrounding `HttpServer`. Provide the handlers
 * ({@link DiaRpcHandlersLive}) and an `HttpServer` layer bound to the loopback interface. An
 * upgrade is refused with 403 when its `Origin` is not in `options.allowedOrigins`, and with
 * 401 when it does not offer the token subprotocol. An upgrade whose offered protocol version
 * differs from {@link PROTOCOL_VERSION} is accepted and then closed with
 * {@link CLOSE_PROTOCOL_MISMATCH}, because a browser reports a refused upgrade as close code 1006
 * whatever the cause.
 */
export const makeHostServerLive = (options: HostServerOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
      const rpcServer = RpcServer.layer(DiaRpcs).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol)(protocol))
      )
      const listener = HttpServer.serve()(handleUpgrade(options, httpEffect))
      return Layer.merge(rpcServer, listener)
    }).pipe(Effect.provide(RpcSerialization.layerJson))
  )
