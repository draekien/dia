import { Schema } from 'effect'

const StringMap = Schema.Record(Schema.String, Schema.String)

/**
 * A stdio, http or sse MCP server a session gets in addition to its defaults; a subset of the
 * Agent SDK's
 * `McpServerConfig`. `args`, `env` and `headers` are required; empty means none.
 */
export const McpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('stdio'),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: StringMap
  }),
  Schema.Struct({ type: Schema.Literal('http'), url: Schema.String, headers: StringMap }),
  Schema.Struct({ type: Schema.Literal('sse'), url: Schema.String, headers: StringMap })
])
export type McpServer = typeof McpServer.Type

/**
 * Permission rules in Claude Code rule syntax (`Bash(git push *)`, `Read`, `mcp__github`).
 * `allow` approves a matching call, `ask` always asks the user, `deny` blocks it in every
 * permission mode. All empty means no rules are added.
 */
export const PermissionRules = Schema.Struct({
  allow: Schema.Array(Schema.String),
  ask: Schema.Array(Schema.String),
  deny: Schema.Array(Schema.String)
})
export type PermissionRules = typeof PermissionRules.Type

/**
 * The permission rules and MCP servers, keyed by server name, a session gets in addition to its
 * defaults. Pass it as `AgentSessionOptions.tools`; pass none for an ad-hoc tab.
 */
export const SessionToolOptions = Schema.Struct({
  permissions: PermissionRules,
  mcpServers: Schema.Record(Schema.String, McpServer)
})
export type SessionToolOptions = typeof SessionToolOptions.Type
