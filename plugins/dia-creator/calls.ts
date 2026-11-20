import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** Why a Creator thread could not start; `message` is the text to show the user. */
export const CreatorUnavailableReason = Schema.Literals([
  'no-meta-repo',
  'no-model',
  'definition-missing',
  'worktree'
])

/** A Creator thread could not start, for `reason`. */
export class CreatorUnavailable extends Schema.TaggedError<CreatorUnavailable>()(
  'CreatorUnavailable',
  { reason: CreatorUnavailableReason, message: Schema.String }
) {}

/** A turn could not be reverted, for `reason`; `message` is git's reason or the text to show. */
export class RevertFailed extends Schema.TaggedError<RevertFailed>()('RevertFailed', {
  reason: Schema.Literals(['conflict', 'nothing-to-revert', 'git']),
  message: Schema.String
}) {}

/** A thread's branch could not be merged, for `reason`; `message` is git's reason or the text to show. */
export class MergeFailed extends Schema.TaggedError<MergeFailed>()('MergeFailed', {
  reason: Schema.Literals(['conflict', 'nothing-to-merge', 'git']),
  message: Schema.String
}) {}

/** One commit of a turn: its full id and the first line of its message. */
export const TurnCommit = Schema.Struct({ sha: Schema.String, subject: Schema.String })
export type TurnCommit = typeof TurnCommit.Type

/** A plugin a turn loaded through a `plugin_*` tool, and whether it was loaded cleanly when the turn ended. */
export const PluginLoad = Schema.Struct({ plugin: Schema.String, loaded: Schema.Boolean })
export type PluginLoad = typeof PluginLoad.Type

/**
 * One Creator turn that made a commit or loaded a plugin. `turnId` is the id of the turn's first
 * user message and `messageIds` the ids of every message that opened it. `commits` are oldest
 * first and empty until the turn ends; `revert` is the commit that reverted them, or null.
 */
export const TurnChange = Schema.Struct({
  turnId: Schema.String,
  messageIds: Schema.Array(Schema.String),
  ended: Schema.Boolean,
  commits: Schema.Array(TurnCommit),
  loads: Schema.Array(PluginLoad),
  revert: Schema.NullOr(Schema.Struct({ sha: Schema.String }))
})
export type TurnChange = typeof TurnChange.Type

/**
 * A Creator thread's turns with changes in transcript order, `unmerged`, the number of commits on
 * its branch that the meta repo's branch lacks, and `lastMerge`, its latest merge commit or null.
 */
export const CreatorThreadState = Schema.Struct({
  turns: Schema.Array(TurnChange),
  unmerged: Schema.Int,
  lastMerge: Schema.NullOr(Schema.Struct({ sha: Schema.String }))
})
export type CreatorThreadState = typeof CreatorThreadState.Type

/**
 * Starts a Creator thread in a new worktree of the meta repo, sends it `text`, and returns its run
 * id; its tab is listed under Meta and not selected, so show it with `dia-runs`' `OpenRunInTab`.
 */
export const StartCreatorThread = Rpc.make('StartCreatorThread', {
  payload: { text: Schema.NonEmptyString },
  success: Schema.String,
  error: CreatorUnavailable
})

/**
 * Streams Creator run `runId`'s {@link CreatorThreadState}: at once, then after each change. A run
 * that is not a Creator run streams an empty state.
 */
export const FollowCreatorThread = Rpc.make('FollowCreatorThread', {
  payload: { runId: Schema.String },
  success: CreatorThreadState,
  stream: true
})

/**
 * Adds a commit to run `runId`'s branch that reverts turn `turnId`'s commits, reloads the plugins
 * those commits changed, and returns the turn with `revert` set. Reverting a reverted turn returns
 * it unchanged.
 */
export const RevertTurn = Rpc.make('RevertTurn', {
  payload: { runId: Schema.String, turnId: Schema.String },
  success: TurnChange,
  error: RevertFailed
})

/**
 * Merges run `runId`'s branch into the meta repo's current branch, moves the plugins loaded from
 * the thread's worktree to the meta repo, reloads them, and returns the merge commit.
 */
export const MergeCreatorThread = Rpc.make('MergeCreatorThread', {
  payload: { runId: Schema.String },
  success: Schema.Struct({ sha: Schema.String }),
  error: MergeFailed
})
