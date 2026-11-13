import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * Creates a token for an agent outside dia and returns `command`, a `claude mcp add` command line
 * that configures `dia-mcp` with it as a stdio MCP server named `dia`. The token lists every dia
 * tool offered to outside agents, survives a dia restart, and is shown only in `command`.
 */
export const IssueOutsideToken = Rpc.make('IssueOutsideToken', {
  payload: {},
  success: Schema.Struct({ command: Schema.String })
})

/** Revokes every token issued with {@link IssueOutsideToken}; returns how many were revoked. */
export const RevokeOutsideTokens = Rpc.make('RevokeOutsideTokens', {
  payload: {},
  success: Schema.Number
})
