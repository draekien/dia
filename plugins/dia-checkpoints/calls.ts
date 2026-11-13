import { GitFileChange } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * A turn with no end recorded: it is running, or it was interrupted and no later turn has started.
 * `turn` counts from 1; `prompt` is the first line of the turn's first message.
 */
export const TurnOpen = Schema.TaggedStruct('TurnOpen', {
  turn: Schema.Int,
  prompt: Schema.String
})
/** An open turn; see {@link TurnOpen}. */
export type TurnOpen = typeof TurnOpen.Type

/** A finished turn and the files that differ between its start and its end. */
export const TurnFinished = Schema.TaggedStruct('TurnFinished', {
  turn: Schema.Int,
  prompt: Schema.String,
  files: Schema.Array(GitFileChange)
})
/** A finished turn; see {@link TurnFinished}. */
export type TurnFinished = typeof TurnFinished.Type

/** One turn of a run, open or finished. */
export const TurnChanges = Schema.Union([TurnOpen, TurnFinished])
/** One turn of a run; see {@link TurnChanges}. */
export type TurnChanges = typeof TurnChanges.Type

/**
 * The changes of run `runId` could not be read: git, runs or run events are not provided, the run
 * or its turn has no records, or git failed.
 */
export class ChangesUnavailable extends Schema.TaggedError<ChangesUnavailable>()(
  'ChangesUnavailable',
  { runId: Schema.String }
) {}

/**
 * Run `runId`'s turns in order, now and after each turn snapshot of the run. Empty while git, runs
 * or run events are not provided, or when the run has no records.
 */
export const FollowRunChanges = Rpc.make('FollowRunChanges', {
  payload: { runId: Schema.String },
  success: Schema.Array(TurnChanges),
  stream: true
})

/** The patch of file `path` in finished turn `turn` of run `runId`, as `git diff` prints it. */
export const GetFileDiff = Rpc.make('GetFileDiff', {
  payload: { runId: Schema.String, turn: Schema.Int, path: Schema.String },
  success: Schema.String,
  error: ChangesUnavailable
})
