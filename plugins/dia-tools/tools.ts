import { type DiaTool, ServiceKey, type ToolScope } from '@dia/plugin'
import { Crypto, Effect, Predicate, Result, Schema, type Scope } from 'effect'
import { Hex } from 'effect/encoding'

/** What a tool asks the user to approve: `title` names the change; `before` and `after` show it. */
export const ApprovalRequest = Schema.Struct({
  title: Schema.NonEmptyString,
  before: Schema.String,
  after: Schema.String
})
/** The decoded type of {@link ApprovalRequest}. */
export type ApprovalRequest = typeof ApprovalRequest.Type

/** The user's answer to an {@link ApprovalRequest}. */
export const ApprovalAnswer = Schema.Literals(['approved', 'declined'])
/** The decoded type of {@link ApprovalAnswer}. */
export type ApprovalAnswer = typeof ApprovalAnswer.Type

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
 *   so grant every live token again. The scope is stored as a copy, so a handler receives an
 *   equal scope, not the object passed to `grant`.
 * - `revoke` refuses that token from now on, declines its pending approvals and ends its MCP
 *   sessions.
 * - `url` is the Streamable HTTP endpoint (`http://127.0.0.1:<port>/mcp`); pass it to an agent
 *   with `Authorization: Bearer <token>`. It stays the same across a reload of `dia-tools`.
 * - `mcpServer` returns a new, unconnected `McpServer` of `@modelcontextprotocol/sdk` for
 *   `scope`, for a caller that runs the agent in process: pass it as the Agent SDK's
 *   `{ type: 'sdk', name: 'dia', instance }`. It is typed `object` because an exported module
 *   cannot import the MCP SDK. Close the server when the run ends: its pending approvals end
 *   only then.
 * - `requestApproval` shows `request` to the user as coming from `scope` and waits for the
 *   answer. Pass the scope the tool handler received. It succeeds with 'declined' when the user
 *   declines, when the token `scope` was granted under is revoked (the run ended), or when
 *   `dia-tools` closes; at once when that has already happened. It has no timeout. Interrupting
 *   it withdraws the request. It dies when `request` has an empty `title`. A request through a
 *   server from `mcpServer` is under no token: it ends when it is answered, when its call is
 *   cancelled or its server closes, or when `dia-tools` closes.
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
  readonly requestApproval: (
    scope: ToolScope,
    request: ApprovalRequest
  ) => Effect.Effect<ApprovalAnswer>
}

const isTools = (value: unknown): value is Tools =>
  Predicate.hasProperty(value, 'register') &&
  Predicate.isFunction(value.register) &&
  Predicate.hasProperty(value, 'grant') &&
  Predicate.isFunction(value.grant) &&
  Predicate.hasProperty(value, 'revoke') &&
  Predicate.isFunction(value.revoke) &&
  Predicate.hasProperty(value, 'url') &&
  Predicate.isString(value.url) &&
  Predicate.hasProperty(value, 'requestApproval') &&
  Predicate.isFunction(value.requestApproval)

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
