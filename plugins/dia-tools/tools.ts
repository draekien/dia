import { type DiaTool, ServiceKey, type ToolScope } from '@dia/plugin'
import { Crypto, Effect, Predicate, Result, type Scope } from 'effect'
import { Hex } from 'effect/encoding'

/** How a registered {@link DiaTool} chooses its callers: `when` accepts the scopes that list it. */
export interface ToolRegistration {
  readonly when: (scope: ToolScope) => boolean
}

/**
 * The registry of dia tools and the MCP endpoint serving it, as `dia-tools` provides it under
 * {@link ToolsKey} (ADR-0075). Read it with `ctx.whenProvided`, so a reload of `dia-tools` does
 * not close the reader.
 *
 * - `register` offers `tool` to every scope `options.when` accepts until the calling scope
 *   closes; connected MCP clients are told the tool list changed. A second tool with a name
 *   already registered is ignored for scopes the first one serves.
 * - `forScope` lists the tools a caller with `scope` sees.
 * - `grant` accepts the token whose {@link hashToken} is `tokenHash` as `scope`, until `revoke`.
 *   Granted hashes are held in memory only: a provider that appears after a reload holds none,
 *   so grant every live token again.
 * - `revoke` refuses that token from now on and ends its MCP sessions.
 * - `url` is the Streamable HTTP endpoint (`http://127.0.0.1:<port>/mcp`); pass it to an agent
 *   with `Authorization: Bearer <token>`. It stays the same across a reload of `dia-tools`.
 * - `mcpServer` returns a new, unconnected `McpServer` of `@modelcontextprotocol/sdk` for
 *   `scope`, for a caller that runs the agent in process: pass it as the Agent SDK's
 *   `{ type: 'sdk', name: 'dia', instance }`. It is typed `object` because an exported module
 *   cannot import the MCP SDK.
 */
export interface Tools {
  readonly register: (
    tool: DiaTool,
    options: ToolRegistration
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly forScope: (scope: ToolScope) => Effect.Effect<ReadonlyArray<DiaTool>>
  readonly grant: (tokenHash: string, scope: ToolScope) => Effect.Effect<void>
  readonly revoke: (tokenHash: string) => Effect.Effect<void>
  readonly url: string
  readonly mcpServer: (scope: ToolScope) => Effect.Effect<object>
}

const isTools = (value: unknown): value is Tools =>
  Predicate.hasProperty(value, 'register') &&
  Predicate.isFunction(value.register) &&
  Predicate.hasProperty(value, 'grant') &&
  Predicate.isFunction(value.grant) &&
  Predicate.hasProperty(value, 'url') &&
  Predicate.isString(value.url)

/** The key `dia-tools` provides its {@link Tools} under: `tools`. */
export const ToolsKey = ServiceKey.make('tools', isTools)

/** The name agents see dia's MCP server under; tool names read `mcp__dia__<tool>`. */
export const DIA_SERVER_NAME = 'dia'

const TOKEN_BYTES = 32

/** The hex SHA-256 hash of `token`, the form {@link Tools.grant} and `revoke` take. */
export const hashToken = Effect.fnUntraced(function* (token: string) {
  const crypto = yield* Crypto.Crypto
  const utf8 = Result.getOrThrow(Hex.decode(Hex.encode(token)))
  const digest = yield* crypto.digest('SHA-256', utf8).pipe(Effect.orDie)
  return Hex.encode(digest)
})

/** A new random token and its {@link hashToken}. Hand `token` to the agent; grant `hash`. */
export const newToken = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const token = Hex.encode(yield* crypto.randomBytes(TOKEN_BYTES).pipe(Effect.orDie))
  return { token, hash: yield* hashToken(token) }
})
