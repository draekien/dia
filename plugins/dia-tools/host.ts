import type { HostPluginContext, PluginSetup, ToolScope } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { type Crypto, Effect, type FileSystem, Layer, Option, Path, Ref, Semaphore } from 'effect'
import { IssueOutsideToken, RevokeOutsideTokens } from './calls'
import { MCP_HOST, MCP_PATH, serveMcp } from './http-server'
import { makeMcpServer } from './mcp-server'
import { makeToolRegistry, type ToolRegistry } from './registry'
import {
  ENDPOINT_FILE,
  OUTSIDE_TOKENS_FILE,
  readOutsideTokens,
  readPort,
  writeOutsideTokens,
  writePort
} from './store'
import { DIA_SERVER_NAME, newToken, type Tools, ToolsKey } from './tools'

const OUTSIDE_SCOPE: ToolScope = { labels: [], context: undefined }

const DIA_MCP_SCRIPT = 'dia-mcp.js'

const quote = (value: string) => `"${value}"`

const outsideCommand = (token: string, script: string, endpointFile: string) =>
  [
    'claude mcp add',
    `--env DIA_MCP_TOKEN=${token}`,
    '--env ELECTRON_RUN_AS_NODE=1',
    '--scope user --transport stdio',
    DIA_SERVER_NAME,
    '--',
    quote(process.execPath),
    quote(script),
    quote(endpointFile)
  ].join(' ')

const makeOutsideTokens = Effect.fnUntraced(function* (
  registry: ToolRegistry,
  revoke: (tokenHash: string) => Effect.Effect<void>,
  file: string,
  endpointFile: string
) {
  const path = yield* Path.Path
  const services = yield* Effect.context<FileSystem.FileSystem | Crypto.Crypto>()
  const hashes = yield* Ref.make(yield* readOutsideTokens(file))
  const lock = yield* Semaphore.make(1)
  yield* Effect.forEach(yield* Ref.get(hashes), (hash) => registry.grant(hash, OUTSIDE_SCOPE), {
    discard: true
  })
  const scriptPath = Effect.sync(
    () => new URL(DIA_MCP_SCRIPT, import.meta.resolve('@dia/plugin'))
  ).pipe(Effect.flatMap(path.fromFileUrl), Effect.orDie)

  const issue = Effect.gen(function* () {
    const script = yield* scriptPath
    const { token, hash } = yield* newToken
    const next = [...(yield* Ref.get(hashes)), hash]
    yield* writeOutsideTokens(file, next).pipe(Effect.orDie)
    yield* Ref.set(hashes, next)
    yield* registry.grant(hash, OUTSIDE_SCOPE)
    yield* Effect.logInfo('Issued a dia tools token for an outside agent', { tokens: next.length })
    return { command: outsideCommand(token, script, endpointFile) }
  }).pipe(lock.withPermits(1), Effect.provide(services))

  const revokeAll = Effect.gen(function* () {
    const revoked = yield* Ref.getAndSet(hashes, [])
    yield* Effect.forEach(revoked, revoke, { discard: true })
    yield* writeOutsideTokens(file, []).pipe(Effect.orDie)
    yield* Effect.logInfo('Revoked every outside agent dia tools token', {
      tokens: revoked.length
    })
    return revoked.length
  }).pipe(lock.withPermits(1), Effect.provide(services))

  return { issue, revokeAll }
})

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const registry = yield* makeToolRegistry
    const endpointFile = path.join(ctx.dataDir, ENDPOINT_FILE)
    const stored = yield* readPort(endpointFile)
    const endpoint = yield* serveMcp(
      registry,
      Option.getOrElse(stored, () => 0)
    )
    if (!Option.contains(stored, endpoint.port)) yield* writePort(endpointFile, endpoint.port)
    const services = yield* Effect.context<never>()
    const revoke = (tokenHash: string) =>
      registry.revoke(tokenHash).pipe(Effect.andThen(endpoint.closeSessions(tokenHash)))

    const tools: Tools = {
      register: registry.register,
      forScope: registry.forScope,
      grant: registry.grant,
      revoke,
      url: `http://${MCP_HOST}:${endpoint.port}${MCP_PATH}`,
      mcpServer: (scope) => Effect.sync(() => makeMcpServer(registry, scope, services))
    }
    yield* ctx.provide(ToolsKey, tools)

    const outside = yield* makeOutsideTokens(
      registry,
      revoke,
      path.join(ctx.dataDir, OUTSIDE_TOKENS_FILE),
      endpointFile
    )
    yield* ctx.serve(IssueOutsideToken, () => outside.issue)
    yield* ctx.serve(RevokeOutsideTokens, () => outside.revokeAll)
    yield* Effect.logInfo('Dia tools provided', { plugin: ctx.name, url: tools.url })
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))

export default setup
