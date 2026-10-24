import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool
} from '@anthropic-ai/claude-agent-sdk'
import type { DiaTool, DiaToolResult } from '@dia/plugin'
import { Effect } from 'effect'
import { z } from 'zod'

/** Key under which the dia tools' MCP server is passed in `mcpServers`; it is the server segment of every tool name. */
export const DIA_TOOL_SERVER_KEY = 'dia'

/** The name the SDK reports for the dia tool `name` (`mcp__dia__plugin_reload`). */
export const qualifiedToolName = (name: string): string => `mcp__${DIA_TOOL_SERVER_KEY}__${name}`

/**
 * Whether `toolName`, as the SDK reports it to `canUseTool`, is one of `tools`. Those tools ask
 * the user for approval themselves, so `canUseTool` lets them through to avoid asking twice.
 */
export const isDiaToolName = (tools: ReadonlyArray<DiaTool>, toolName: string): boolean =>
  tools.some((candidate) => qualifiedToolName(candidate.name) === toolName)

/** Collaborators of {@link makeDiaToolServer}. */
export interface DiaToolServerOptions {
  readonly tools: ReadonlyArray<DiaTool>
  /** Asks the user to approve a call and resolves whether they did. Called once per tool call, whatever the permission mode. */
  readonly approve: (toolName: string, input: Record<string, string>) => Effect.Effect<boolean>
  /** Runs an effect to completion; the SDK calls tool handlers with a Promise. */
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>
}

interface McpToolResult {
  readonly [key: string]: unknown
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>
  readonly isError?: boolean
}

const toMcpResult = (result: DiaToolResult): McpToolResult => ({
  content: [{ type: 'text', text: result.text }],
  ...(result.isError ? { isError: true } : {})
})

const declined: DiaToolResult = {
  text: 'The user did not approve this plugin change.',
  isError: true
}

const inputShape = (diaTool: DiaTool): z.ZodRawShape =>
  Object.fromEntries(
    Object.entries(diaTool.input).map(([field, spec]) => [
      field,
      z.string().regex(spec.pattern).describe(spec.description)
    ])
  )

/**
 * The SDK tool definitions for `options.tools`. Every call first asks the user through
 * `approve` under the tool's qualified name and does nothing when they decline, so approval
 * does not depend on the pane's permission mode.
 */
export const makeDiaSdkTools = (options: DiaToolServerOptions) =>
  options.tools.map((diaTool) =>
    tool(diaTool.name, diaTool.description, inputShape(diaTool), (args) =>
      options.run(
        Effect.gen(function* () {
          const input = args as Record<string, string>
          const approved = yield* options.approve(qualifiedToolName(diaTool.name), input)
          if (!approved) {
            yield* Effect.logInfo('Dia tool call declined', { tool: diaTool.name, input })
            return toMcpResult(declined)
          }
          yield* Effect.logInfo('Dia tool call approved', { tool: diaTool.name, input })
          return toMcpResult(yield* diaTool.run(input))
        })
      )
    )
  )

/**
 * An in-process MCP server carrying {@link makeDiaSdkTools}. Create one for each `query()`: the
 * SDK connects a server instance to a single query. Pass it as
 * `mcpServers: { [DIA_TOOL_SERVER_KEY]: server }`.
 */
export const makeDiaToolServer = (options: DiaToolServerOptions): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({ name: DIA_TOOL_SERVER_KEY, tools: makeDiaSdkTools(options) })
