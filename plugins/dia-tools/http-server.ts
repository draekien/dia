// @effect-diagnostics-next-line nodeBuiltinImport:off -- the MCP SDK's server transports take Node's request and response objects.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ToolScope } from '@dia/plugin'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { Crypto, Data, Effect, Option, Schema, type Scope, Stream } from 'effect'
import { makeMcpServer } from './mcp-server'
import type { ToolRegistry } from './registry'
import { hashToken } from './tools'

/** The host address the MCP endpoint listens on; it is never reachable from another machine. */
export const MCP_HOST = '127.0.0.1'
/** The path of the Streamable HTTP endpoint. */
export const MCP_PATH = '/mcp'
const SSE_PATH = '/sse'
const SSE_MESSAGES_PATH = '/messages'
const SESSION_HEADER = 'mcp-session-id'

/** The MCP endpoint could not listen on any port. */
export class McpListenError extends Data.TaggedError('McpListenError')<{
  readonly message: string
}> {}

/**
 * A listening MCP endpoint: `port` it listens on, and `closeSessions`, which ends every MCP
 * session a token with hash `tokenHash` opened.
 */
export interface McpEndpoint {
  readonly port: number
  readonly closeSessions: (tokenHash: string) => Effect.Effect<void>
}

interface Session {
  readonly tokenHash: string
  readonly server: McpServer
  readonly transport: StreamableHTTPServerTransport | SSEServerTransport
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const reply = (res: ServerResponse, status: number, message: string, headers = {}) =>
  Effect.sync(() => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(encodeJson({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  })

const readBody = (req: IncomingMessage) =>
  Effect.callback<string>((resume) => {
    const chunks: Array<Buffer> = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resume(Effect.succeed(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', () => resume(Effect.succeed('')))
  })

const bearerOf = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
}

const listen = (server: Server, port: number) =>
  Effect.callback<number, McpListenError>((resume) => {
    const onError = (error: Error) =>
      resume(Effect.fail(new McpListenError({ message: error.message })))
    server.once('error', onError)
    server.listen(port, MCP_HOST, () => {
      server.off('error', onError)
      const address = server.address()
      resume(Effect.succeed(typeof address === 'object' && address !== null ? address.port : port))
    })
  })

/**
 * Serves `registry` over Streamable HTTP at `http://127.0.0.1:<port>/mcp` and over HTTP+SSE at
 * `/sse` and `/messages`, until the calling scope closes. Every request needs
 * `Authorization: Bearer <token>` for a token `registry` holds a grant for (else `401`) and no
 * `Origin` header (else `403`). An MCP session serves the scope of the token that opened it and
 * refuses any other token. Every session is told when the registered tools change. Listens on
 * `port`, or on a free port when `port` is 0 or taken.
 */
export const serveMcp = Effect.fn('DiaTools.serveMcp')(function* (
  registry: ToolRegistry,
  port: number
): Effect.fn.Return<McpEndpoint, McpListenError, Scope.Scope | Crypto.Crypto> {
  const services = yield* Effect.context<Crypto.Crypto>()
  const run = Effect.runForkWith(services)
  const sessions = new Map<string, Session>()

  const authorise = Effect.fnUntraced(function* (req: IncomingMessage, res: ServerResponse) {
    if (req.headers.origin !== undefined) {
      yield* Effect.logWarning('Refused an MCP request with an Origin header', {
        origin: req.headers.origin
      })
      yield* reply(res, 403, 'Requests from a browser origin are refused.')
      return Option.none<{ hash: string; scope: ToolScope }>()
    }
    const token = bearerOf(req)
    const hash = token === undefined ? undefined : yield* hashToken(token)
    const scope = hash === undefined ? Option.none() : yield* registry.scopeOf(hash)
    if (hash !== undefined && Option.isSome(scope)) return Option.some({ hash, scope: scope.value })
    yield* Effect.logWarning('Refused an MCP request without a valid token', {
      hasToken: token !== undefined
    })
    yield* reply(res, 401, 'A valid dia tools token is required.', { 'www-authenticate': 'Bearer' })
    return Option.none<{ hash: string; scope: ToolScope }>()
  })

  const existing = Effect.fnUntraced(function* (
    res: ServerResponse,
    sessionId: string,
    hash: string
  ) {
    const session = sessions.get(sessionId)
    if (session === undefined) {
      yield* reply(res, 404, 'Unknown MCP session.')
      return Option.none<Session>()
    }
    if (session.tokenHash !== hash) {
      yield* Effect.logWarning('Refused an MCP session opened with another token', { sessionId })
      yield* reply(res, 403, 'This MCP session belongs to another token.')
      return Option.none<Session>()
    }
    return Option.some(session)
  })

  const open = (
    hash: string,
    scope: ToolScope,
    transport: StreamableHTTPServerTransport | SSEServerTransport
  ) =>
    Effect.gen(function* () {
      const server = makeMcpServer(registry, scope, services)
      yield* Effect.promise(() => server.connect(transport))
      return { tokenHash: hash, server, transport } satisfies Session
    })

  const streamable = Effect.fnUntraced(function* (
    req: IncomingMessage,
    res: ServerResponse,
    hash: string,
    scope: ToolScope
  ) {
    const sessionId = req.headers[SESSION_HEADER]
    if (typeof sessionId === 'string') {
      const session = yield* existing(res, sessionId, hash)
      if (Option.isNone(session)) return
      const { transport } = session.value
      if (transport instanceof StreamableHTTPServerTransport) {
        yield* Effect.promise(() => transport.handleRequest(req, res))
      } else yield* reply(res, 400, 'This session uses the SSE transport.')
      return
    }
    if (req.method !== 'POST') return yield* reply(res, 400, 'No MCP session id was sent.')
    const body = yield* decodeJson(yield* readBody(req)).pipe(Effect.option)
    if (Option.isNone(body) || !isInitializeRequest(body.value)) {
      return yield* reply(res, 400, 'The first request of a session must be initialize.')
    }
    const newSessionId = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie)
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => {
        sessions.set(id, session)
        run(Effect.logInfo('Opened an MCP session', { sessionId: id, runId: scope.runId }))
      }
    })
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
    }
    const session = yield* open(hash, scope, transport)
    yield* Effect.promise(() => transport.handleRequest(req, res, body.value))
  })

  const sse = Effect.fnUntraced(function* (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    hash: string,
    scope: ToolScope
  ) {
    if (url.pathname === SSE_PATH && req.method === 'GET') {
      const transport = new SSEServerTransport(SSE_MESSAGES_PATH, res)
      sessions.set(transport.sessionId, yield* open(hash, scope, transport))
      res.on('close', () => sessions.delete(transport.sessionId))
      return yield* Effect.logInfo('Opened an MCP SSE session', {
        sessionId: transport.sessionId,
        runId: scope.runId
      })
    }
    const sessionId = url.searchParams.get('sessionId')
    if (req.method !== 'POST' || sessionId === null) {
      return yield* reply(res, 400, 'POST a message with a sessionId.')
    }
    const session = yield* existing(res, sessionId, hash)
    if (Option.isNone(session)) return
    const { transport } = session.value
    if (transport instanceof SSEServerTransport) {
      yield* Effect.promise(() => transport.handlePostMessage(req, res))
    } else yield* reply(res, 400, 'This session uses the Streamable HTTP transport.')
  })

  const handle = Effect.fnUntraced(
    function* (req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? '/', `http://${MCP_HOST}`)
      if (![MCP_PATH, SSE_PATH, SSE_MESSAGES_PATH].includes(url.pathname)) {
        return yield* reply(res, 404, 'Not found.')
      }
      const caller = yield* authorise(req, res)
      if (Option.isNone(caller)) return
      const { hash, scope } = caller.value
      if (url.pathname === MCP_PATH) return yield* streamable(req, res, hash, scope)
      return yield* sse(req, res, url, hash, scope)
    },
    (effect, _req, res) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logError('An MCP request failed', { cause }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (!res.headersSent) res.writeHead(500)
                res.end()
              })
            )
          )
        )
      )
  )

  const closeSession = (id: string, session: Session) =>
    Effect.promise(() => session.server.close()).pipe(
      Effect.ensuring(Effect.sync(() => sessions.delete(id)))
    )

  const server = createServer((req, res) => {
    run(handle(req, res))
  })
  const listening = yield* Effect.acquireRelease(
    listen(server, port).pipe(
      Effect.catch((error) =>
        port === 0
          ? Effect.fail(error)
          : Effect.logWarning('The stored MCP port is taken; listening on a free port', {
              port,
              message: error.message
            }).pipe(Effect.andThen(listen(server, 0)))
      )
    ),
    () =>
      Effect.forEach([...sessions], ([id, session]) => closeSession(id, session), {
        discard: true
      }).pipe(
        Effect.andThen(
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void))
            server.closeAllConnections()
          })
        ),
        Effect.andThen(Effect.logInfo('Closed the MCP endpoint'))
      )
  )

  yield* registry.changes.pipe(
    Stream.runForEach(() =>
      Effect.sync(() => {
        for (const session of sessions.values()) session.server.sendToolListChanged()
      }).pipe(
        Effect.andThen(
          Effect.logDebug('Announced a dia tool list change', { sessions: sessions.size })
        )
      )
    ),
    Effect.forkScoped
  )
  yield* Effect.logInfo('Serving dia tools over MCP', { port: listening })

  return {
    port: listening,
    closeSessions: (tokenHash) =>
      Effect.forEach(
        [...sessions].filter(([, session]) => session.tokenHash === tokenHash),
        ([id, session]) => closeSession(id, session),
        { discard: true }
      )
  }
})
