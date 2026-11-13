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

/** Collaborators of {@link makeDiaToolServer}. */
export interface DiaToolServerOptions {
  readonly tools: ReadonlyArray<DiaTool>
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

const inputShape = (diaTool: DiaTool): z.ZodRawShape =>
  Object.fromEntries(
    Object.entries(diaTool.input).map(([field, spec]) => {
      const schema = z.string().regex(spec.pattern).describe(spec.description)
      return [field, spec.optional === true ? schema.optional() : schema]
    })
  )

/**
 * The SDK tool definitions for `options.tools`. Each call runs the tool and logs the call and its
 * outcome; permission handling belongs to the session's `canUseTool`, which the SDK applies
 * before the handler runs.
 */
export const makeDiaSdkTools = (options: DiaToolServerOptions) =>
  options.tools.map((diaTool) =>
    tool(diaTool.name, diaTool.description, inputShape(diaTool), (args) =>
      options.run(
        Effect.gen(function* () {
          const input = args as Record<string, string | undefined>
          yield* Effect.logInfo('Dia tool call', { tool: diaTool.name, input })
          const result = yield* diaTool.run(input)
          yield* Effect.logInfo('Dia tool call returned', {
            tool: diaTool.name,
            isError: result.isError
          })
          return toMcpResult(result)
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
