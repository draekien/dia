import { Brand } from 'effect'

/** Text of the MCP servers editor. Branded so that only the mcp plugin constructs one. */
export type McpServersDraft = string & Brand.Brand<'McpServersDraft'>

/** The draft holding `text` as the user typed it. */
export const draftOfText = Brand.nominal<McpServersDraft>()
