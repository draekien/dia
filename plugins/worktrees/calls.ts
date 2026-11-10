import { WorktreeInfo, WorktreeOwner } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** A worktree whose session runs in it now. */
export const Active = Schema.TaggedStruct('Active', {})

/** A released worktree left on disk because `changedFiles` files in it are modified or untracked. */
export const NeedsDecision = Schema.TaggedStruct('NeedsDecision', { changedFiles: Schema.Int })

/** A worktree the user chose to keep; `changedFiles` is the count recorded when it was released. */
export const Kept = Schema.TaggedStruct('Kept', { changedFiles: Schema.Int })

/** A worktree whose directory is gone; its branch is kept. */
export const Removed = Schema.TaggedStruct('Removed', {})

/** Where a worktree stands in the ledger. */
export const LedgerState = Schema.Union([Active, NeedsDecision, Kept, Removed])
export type LedgerState = typeof LedgerState.Type

/** One ledger row: the worktree, who it serves, its state, and when the state last changed (epoch ms). */
export const LedgerEntry = Schema.Struct({
  info: WorktreeInfo,
  owner: WorktreeOwner,
  state: LedgerState,
  updatedAt: Schema.Number
})
export type LedgerEntry = typeof LedgerEntry.Type

/**
 * A call needed a worktree in a state it was not in (for example a pane reattached it after the
 * page rendered). `state` is the state the ledger holds now.
 */
export class LedgerStateChanged extends Schema.TaggedError<LedgerStateChanged>()(
  'LedgerStateChanged',
  { path: Schema.String, state: LedgerState }
) {}

/** Streams every ledger row: the current list, then the list after each change. */
export const WatchWorktrees = Rpc.make('WatchWorktrees', {
  payload: {},
  success: Schema.Array(LedgerEntry),
  stream: true
})

/**
 * Force-removes the directory of the `NeedsDecision` or `Kept` worktree at `path`, deleting its
 * modified and untracked files but never its branch, and marks it `Removed`. Fails with
 * {@link LedgerStateChanged} when the row is in any other state.
 */
export const DiscardWorktree = Rpc.make('DiscardWorktree', {
  payload: { path: Schema.String },
  error: LedgerStateChanged
})

/**
 * Marks the `NeedsDecision` worktree at `path` as `Kept`. Fails with {@link LedgerStateChanged}
 * when the row is in any other state.
 */
export const KeepWorktree = Rpc.make('KeepWorktree', {
  payload: { path: Schema.String },
  error: LedgerStateChanged
})
