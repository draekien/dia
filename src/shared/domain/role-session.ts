import { Schema } from 'effect'

const StringMap = Schema.Record(Schema.String, Schema.String)

/**
 * A stdio, http or sse MCP server a role adds to its sessions; a subset of the Agent SDK's
 * `McpServerConfig`. `args`, `env` and `headers` are required; empty means none.
 */
export const RoleMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('stdio'),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: StringMap
  }),
  Schema.Struct({ type: Schema.Literal('http'), url: Schema.String, headers: StringMap }),
  Schema.Struct({ type: Schema.Literal('sse'), url: Schema.String, headers: StringMap })
])
export type RoleMcpServer = typeof RoleMcpServer.Type

/**
 * Permission rules in Claude Code rule syntax (`Bash(git push *)`, `Read`, `mcp__github`).
 * `allow` approves a matching call, `ask` always asks the user, `deny` blocks it in every
 * permission mode. All empty means the role adds no rules.
 */
export const PermissionRules = Schema.Struct({
  allow: Schema.Array(Schema.String),
  ask: Schema.Array(Schema.String),
  deny: Schema.Array(Schema.String)
})
export type PermissionRules = typeof PermissionRules.Type

/**
 * What a role adds to an agent session: its permission rules, and its MCP servers keyed by
 * server name. Pass it as `AgentSessionOptions.role` when the Host opens a hired agent's session.
 */
export const RoleSessionOptions = Schema.Struct({
  permissions: PermissionRules,
  mcpServers: Schema.Record(Schema.String, RoleMcpServer)
})
export type RoleSessionOptions = typeof RoleSessionOptions.Type
