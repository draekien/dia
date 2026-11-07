import { Result, Schema } from 'effect'
import { draftOfText, type McpServersDraft } from './draft'

const StringMap = Schema.Record(Schema.String, Schema.String)

/**
 * One MCP server as `.mcp.json` declares it: stdio (`command`, `args`, `env`), http or sse (`url`,
 * `headers`); a subset of the Agent SDK's `McpServerConfig`. `args`, `env` and `headers` are
 * required; empty means none.
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
/** The decoded type of {@link McpServer}. */
export type McpServer = typeof McpServer.Type

/** MCP servers keyed by server name. */
export const McpServers = Schema.Record(Schema.String, McpServer)
/** The decoded type of {@link McpServers}. */
export type McpServers = typeof McpServers.Type

/**
 * What the MCP servers editor holds while a user edits. Create one with {@link mcpServersDraft};
 * read one with {@link readMcpServersDraft}.
 */
export type { McpServersDraft }

const decodeJsonObject = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)
const decodeServers = Schema.decodeUnknownResult(McpServers)

const withDefaults = (entry: unknown): unknown => {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
  const server = entry as Record<string, unknown>
  const type = server.type ?? ('command' in server ? 'stdio' : undefined)
  if (type === 'stdio') return { args: [], env: {}, ...server, type }
  if (type === 'http' || type === 'sse') return { headers: {}, ...server, type }
  return server
}

/**
 * The draft that shows `servers`: no servers is an empty draft. Two server maps that give equal
 * drafts configure the same servers.
 */
export const mcpServersDraft = (servers: McpServers): McpServersDraft =>
  draftOfText(Object.keys(servers).length === 0 ? '' : JSON.stringify(servers, null, 2))

/**
 * The servers a draft describes: a JSON object of server name to server, without the
 * `{ "mcpServers": ... }` wrapper. An entry with `command` and no `type` is stdio; a missing
 * `args`, `env` or `headers` is empty; keys the server schema does not know are dropped. A blank
 * draft is no servers. Fails with the message to show under the editor.
 */
export const readMcpServersDraft = (draft: McpServersDraft): Result.Result<McpServers, string> => {
  if (draft.trim() === '') return Result.succeed({})
  const parsed = decodeJsonObject(draft)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message)
  const filled = Object.fromEntries(
    Object.entries(parsed.success).map(([name, server]) => [name, withDefaults(server)])
  )
  return Result.mapError(decodeServers(filled), (error) => error.message)
}
