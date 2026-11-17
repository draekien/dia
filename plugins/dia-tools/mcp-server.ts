import type { DiaTool, DiaToolResult, ToolScope } from '@dia/plugin'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { type Context, Effect, Schema } from 'effect'
import type { ToolRegistry } from './registry'
import { DIA_SERVER_NAME } from './tools'

const SERVER_VERSION = '1.0.0'

const toMcpResult = (result: DiaToolResult): CallToolResult => ({
  content: [{ type: 'text', text: result.text }],
  ...(result.isError ? { isError: true } : {})
})

const inputSchemaOf = (tool: DiaTool): Tool['inputSchema'] => {
  const document = Schema.toJsonSchemaDocument(tool.input)
  const definitions = Object.keys(document.definitions).length === 0
  return {
    ...document.schema,
    type: 'object',
    ...(definitions ? {} : { $defs: document.definitions })
  }
}

const describe = (tool: DiaTool): Tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: inputSchemaOf(tool)
})

const refused = (text: string): DiaToolResult => ({ text, isError: true })

/**
 * Runs the call of tool `name` with `args` for `scope`: a tool `scope` does not list, or `args`
 * its input schema does not decode, is refused with a reason; a tool that dies returns a failure.
 */
export const callTool = Effect.fn('DiaTools.call')(function* (
  registry: ToolRegistry,
  scope: ToolScope,
  name: string,
  args: unknown
) {
  const tool = (yield* registry.forScope(scope)).find((candidate) => candidate.name === name)
  if (tool === undefined) {
    yield* Effect.logWarning('Refused a call to a dia tool this caller does not have', {
      tool: name,
      runId: scope.runId
    })
    return refused(`Unknown tool: ${name}`)
  }
  const input = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(tool.input))(args ?? {}).pipe(
    Effect.result
  )
  if (input._tag === 'Failure') {
    yield* Effect.logInfo('Refused a dia tool call with invalid input', { tool: name })
    return refused(`Invalid input: ${input.failure.message}`)
  }
  yield* Effect.logInfo('Dia tool call', { tool: name, runId: scope.runId })
  const result = yield* tool
    .run(input.success, scope)
    .pipe(
      Effect.catchDefect((defect) =>
        Effect.logError('A dia tool died', { tool: name, defect }).pipe(
          Effect.as(refused(`The ${name} tool failed.`))
        )
      )
    )
  yield* Effect.logInfo('Dia tool call returned', { tool: name, isError: result.isError })
  return result
})

/**
 * A new MCP server that lists and calls `registry`'s tools for `scope`, and announces
 * `notifications/tools/list_changed`. Connect it to one transport; tool calls run with `services`,
 * each wrapped in `track`, and a cancelled call, or closing the server, interrupts the call's tool
 * handler.
 */
export const makeMcpServer = (
  registry: ToolRegistry,
  scope: ToolScope,
  services: Context.Context<never>,
  track: <A>(call: Effect.Effect<A>) => Effect.Effect<A> = (call) => call
): McpServer => {
  const run = Effect.runPromiseWith(services)
  const server = new McpServer(
    { name: DIA_SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } }
  )
  server.server.setRequestHandler(ListToolsRequestSchema, () =>
    run(Effect.map(registry.forScope(scope), (tools) => ({ tools: tools.map(describe) })))
  )
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    run(
      Effect.map(
        track(callTool(registry, scope, request.params.name, request.params.arguments)),
        toMcpResult
      ),
      { signal: extra.signal }
    )
  )
  return server
}
