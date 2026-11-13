import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import type { SessionToolOptions } from '@dia/plugin'
import { McpServer } from '@dia-plugin/dia-mcp/servers'
import { Effect, Option, Result, Schema } from 'effect'

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

const NO_TOOLS: SessionToolOptions = {
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: {},
  skills: []
}

const decodeServer = Schema.decodeUnknownResult(McpServer)

const toSdkServer = (server: McpServer): McpServerConfig =>
  server.type === 'stdio' ? { ...server, args: [...server.args] } : { ...server }

/**
 * The Agent SDK query options that decide which tools a session has and how their calls are
 * approved: the {@link TASK_TRACKING_TOOLS} and `tools`' allow rules as `allowedTools`, its deny
 * rules as `disallowedTools`, its ask rules as `settings.permissions.ask`, its MCP servers (among
 * them dia's own `dia` server) as `mcpServers`, and its skill names as `skills`. A server that does not decode as an `McpServer` is left out and logged. Pass none
 * for an ad-hoc tab. Keys with nothing to set are omitted. Spread the result into a query's
 * `options`.
 */
export const sessionToolOptions = (
  tools: Option.Option<SessionToolOptions>
): Effect.Effect<
  Pick<Options, 'allowedTools' | 'disallowedTools' | 'settings' | 'mcpServers' | 'skills'>
> =>
  Effect.gen(function* () {
    const { permissions, mcpServers, skills } = Option.getOrElse(tools, () => NO_TOOLS)
    const servers: Record<string, McpServerConfig> = {}
    for (const [name, value] of Object.entries(mcpServers)) {
      const server = decodeServer(value)
      if (Result.isFailure(server)) {
        yield* Effect.logWarning('An MCP server was left out of the session', {
          server: name,
          message: server.failure.message
        })
        continue
      }
      servers[name] = toSdkServer(server.success)
    }
    return {
      allowedTools: [...TASK_TRACKING_TOOLS, ...permissions.allow],
      ...(permissions.deny.length === 0 ? {} : { disallowedTools: [...permissions.deny] }),
      ...(permissions.ask.length === 0
        ? {}
        : { settings: { permissions: { ask: [...permissions.ask] } } }),
      ...(Object.keys(servers).length === 0 ? {} : { mcpServers: servers }),
      ...(skills.length === 0 ? {} : { skills: [...skills] })
    }
  })
