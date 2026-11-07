import { Result, Schema } from 'effect'
import { JobTitle } from './domain'

/** A job title's MCP servers, keyed by server name, as `JobTitle.mcpServers` holds them. */
export type McpServers = typeof JobTitle.fields.mcpServers.Type

const decodeJsonObject = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)
const decodeServers = Schema.decodeUnknownResult(JobTitle.fields.mcpServers)

const withDefaults = (entry: unknown): unknown => {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
  const server = entry as Record<string, unknown>
  const type = server.type ?? ('command' in server ? 'stdio' : undefined)
  if (type === 'stdio') return { args: [], env: {}, ...server, type }
  if (type === 'http' || type === 'sse') return { headers: {}, ...server, type }
  return server
}

/**
 * Reads the MCP servers field's text: a JSON object of server name to server, without the
 * `{ "mcpServers": ... }` wrapper. An entry with `command` and no `type` is stdio; a missing
 * `args`, `env` or `headers` is empty; keys the server schema does not know are dropped. Blank
 * text is no servers. Fails with the message to show under the field.
 */
export const parseMcpServers = (text: string): Result.Result<McpServers, string> => {
  if (text.trim() === '') return Result.succeed({})
  const parsed = decodeJsonObject(text)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message)
  const filled = Object.fromEntries(
    Object.entries(parsed.success).map(([name, server]) => [name, withDefaults(server)])
  )
  return Result.mapError(decodeServers(filled), (error) => error.message)
}

/** The MCP servers field's text for `servers`; the empty string when there are none. */
export const printMcpServers = (servers: McpServers): string =>
  Object.keys(servers).length === 0 ? '' : JSON.stringify(servers, null, 2)
