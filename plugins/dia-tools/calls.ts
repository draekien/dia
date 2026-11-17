import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import { ApprovalAnswer, ApprovalRequest } from './tools'

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

/**
 * A dia run started in `project` (its source directory, null when unknown) with `labels` asked
 * for approval; the dialog shows both.
 */
export const RunSource = Schema.TaggedStruct('RunSource', {
  project: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String)
})

/** An agent outside dia asked for approval. */
export const OutsideSource = Schema.TaggedStruct('OutsideSource', {})

/** Where a pending approval came from. Build values with `RunSource.make` and `OutsideSource.make`. */
export const ApprovalSource = Schema.Union([RunSource, OutsideSource])
/** The decoded type of {@link ApprovalSource}. */
export type ApprovalSource = typeof ApprovalSource.Type

/** One request waiting for the user. `id` is a random UUID, so it is never reused after a reload. */
export const PendingApproval = Schema.Struct({
  id: Schema.String,
  source: ApprovalSource,
  request: ApprovalRequest
})
/** The decoded type of {@link PendingApproval}. */
export type PendingApproval = typeof PendingApproval.Type

/** Streams the pending approvals, oldest first: the current list, then the list after each change. */
export const WatchApprovals = Rpc.make('WatchApprovals', {
  payload: {},
  success: Schema.Array(PendingApproval),
  stream: true
})

/**
 * Records the user's answer to pending approval `id`. The first answer for an `id` wins; a later
 * call with that `id`, or an `id` that is no longer pending, is ignored, so a resent call is safe.
 */
export const AnswerApproval = Rpc.make('AnswerApproval', {
  payload: { id: Schema.String, answer: ApprovalAnswer }
})
