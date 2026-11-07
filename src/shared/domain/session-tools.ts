import { Schema } from 'effect'

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
 * defaults. Pass it as `AgentSessionOptions.tools`; pass none for an ad-hoc tab. The kernel does
 * not read an MCP server's value: the mcp plugin owns its shape (`@dia-plugin/mcp/servers`), and
 * the adapter decodes it with that schema.
 */
export const SessionToolOptions = Schema.Struct({
  permissions: PermissionRules,
  mcpServers: Schema.Record(Schema.String, Schema.Unknown)
})
export type SessionToolOptions = typeof SessionToolOptions.Type
