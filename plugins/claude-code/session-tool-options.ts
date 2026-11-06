import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  Options
} from '@anthropic-ai/claude-agent-sdk'
import type { RoleSessionOptions } from '@dia/plugin'
import type { RoleMcpServer } from '@shared/domain/role-session'
import { Option } from 'effect'
import { DIA_TOOL_SERVER_KEY } from './tool-server'

/**
 * The Claude Code task-tracking tools every session allows, so newer models keep them. Included
 * in the `allowedTools` that {@link sessionToolOptions} returns.
 */
export const TASK_TRACKING_TOOLS: ReadonlyArray<string> = [
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList'
]

const NO_ROLE: RoleSessionOptions = {
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: {}
}

const toSdkServer = (server: RoleMcpServer): McpServerConfig =>
  server.type === 'stdio' ? { ...server, args: [...server.args] } : { ...server }

/**
 * The Agent SDK query options that decide which tools a session has and how their calls are
 * approved: the {@link TASK_TRACKING_TOOLS} and `role`'s allow rules as `allowedTools`, its deny
 * rules as `disallowedTools`, its ask rules as `settings.permissions.ask`, and its MCP servers
 * plus `diaToolServer` (under `DIA_TOOL_SERVER_KEY`, replacing a role server of that name) as
 * `mcpServers`. Pass none for an ad-hoc tab. Keys with nothing to set are omitted. Spread the
 * result into a query's `options`.
 */
export const sessionToolOptions = (
  role: Option.Option<RoleSessionOptions>,
  diaToolServer: Option.Option<McpSdkServerConfigWithInstance>
): Pick<Options, 'allowedTools' | 'disallowedTools' | 'settings' | 'mcpServers'> => {
  const { permissions, mcpServers } = Option.getOrElse(role, () => NO_ROLE)
  const servers: Record<string, McpServerConfig> = {
    ...Object.fromEntries(
      Object.entries(mcpServers).map(([name, server]) => [name, toSdkServer(server)])
    ),
    ...Option.match(diaToolServer, {
      onNone: () => ({}),
      onSome: (server) => ({ [DIA_TOOL_SERVER_KEY]: server })
    })
  }
  return {
    allowedTools: [...TASK_TRACKING_TOOLS, ...permissions.allow],
    ...(permissions.deny.length === 0 ? {} : { disallowedTools: [...permissions.deny] }),
    ...(permissions.ask.length === 0
      ? {}
      : { settings: { permissions: { ask: [...permissions.ask] } } }),
    ...(Object.keys(servers).length === 0 ? {} : { mcpServers: servers })
  }
}
