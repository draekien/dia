import { Schema } from 'effect'

/**
 * A possible secret the push scan found (ADR-0047). `rule` is the rule id and `description` its
 * label; `commit` is the full SHA of the commit that adds it; `file` is the path in that commit,
 * or `null` when the line is in the commit message; `line` is the 1-based line in the file or
 * message. It never carries the secret itself.
 */
export const SecretFinding = Schema.Struct({
  rule: Schema.String,
  description: Schema.String,
  commit: Schema.String,
  file: Schema.NullOr(Schema.String),
  line: Schema.Int
})
export type SecretFinding = typeof SecretFinding.Type

/**
 * The meta repo's push settings: `remoteUrl` is the URL of its `origin` remote with any password
 * replaced by `***`, or `null` when it has none; `branch` is the checked-out branch, or `null`
 * when `HEAD` is detached.
 */
export const MetaRepoState = Schema.TaggedStruct('MetaRepoState', {
  remoteUrl: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String)
})
export type MetaRepoState = typeof MetaRepoState.Type

/** A push succeeded: `commitCount` commits of `branch` were scanned and sent to `remoteUrl`. */
export const MetaRepoPushed = Schema.TaggedStruct('MetaRepoPushed', {
  branch: Schema.String,
  remoteUrl: Schema.String,
  commitCount: Schema.Int
})
export type MetaRepoPushed = typeof MetaRepoPushed.Type

/** A push was refused because the scan found `findings`; nothing was sent to the remote. */
export const MetaRepoPushRefused = Schema.TaggedStruct('MetaRepoPushRefused', {
  findings: Schema.NonEmptyArray(SecretFinding)
})
export type MetaRepoPushRefused = typeof MetaRepoPushRefused.Type

/**
 * A meta repo action could not run or git failed; `message` says why, in a form to show the user,
 * with any password in a URL replaced by `***`.
 */
export const MetaRepoFailed = Schema.TaggedStruct('MetaRepoFailed', { message: Schema.String })
export type MetaRepoFailed = typeof MetaRepoFailed.Type

/** Result of reading or changing the meta repo's remote: {@link MetaRepoState} or {@link MetaRepoFailed}. */
export const MetaRepoStateResult = Schema.Union([MetaRepoState, MetaRepoFailed])
export type MetaRepoStateResult = typeof MetaRepoStateResult.Type

/** Result of a meta repo push: {@link MetaRepoPushed}, {@link MetaRepoPushRefused} or {@link MetaRepoFailed}. */
export const MetaRepoPushResult = Schema.Union([
  MetaRepoPushed,
  MetaRepoPushRefused,
  MetaRepoFailed
])
export type MetaRepoPushResult = typeof MetaRepoPushResult.Type
