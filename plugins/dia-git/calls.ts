import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** A checkout on branch `branch`. */
export const OnBranch = Schema.TaggedStruct('OnBranch', { branch: Schema.String })
export type OnBranch = typeof OnBranch.Type

/** A checkout whose `HEAD` is detached at commit `commit`, abbreviated to 7 characters. */
export const DetachedHead = Schema.TaggedStruct('DetachedHead', { commit: Schema.String })
export type DetachedHead = typeof DetachedHead.Type

/** What a checkout has checked out: a branch, or a detached `HEAD`. */
export const CheckoutHead = Schema.Union([OnBranch, DetachedHead])
export type CheckoutHead = typeof CheckoutHead.Type

/**
 * A branch of a repository. `name` is the short name (`main`, `origin/main`); `remote` names the
 * remote a remote-tracking branch belongs to, and is null for a local branch.
 */
export const Branch = Schema.Struct({ name: Schema.String, remote: Schema.NullOr(Schema.String) })
export type Branch = typeof Branch.Type

/**
 * The branches of the repository at a directory. `defaultBase` is the branch a new worktree starts
 * from unless the user picks another: `origin`'s `HEAD` branch, else the checked-out branch, else
 * null. `branches` lists the checked-out branch first, then the other local branches, then the
 * remote-tracking ones, each group in name order; it holds no `<remote>/HEAD` entry.
 */
export const BranchList = Schema.Struct({
  head: CheckoutHead,
  defaultBase: Schema.NullOr(Schema.String),
  branches: Schema.Array(Branch)
})
export type BranchList = typeof BranchList.Type

/** git could not read or change the repository; `reason` is git's message, for the user. */
export class GitCallFailed extends Schema.TaggedError<GitCallFailed>()('GitCallFailed', {
  reason: Schema.String
}) {}

/**
 * The checkout at a directory has changes to tracked files, so its branch was not switched.
 * `branch` is the branch checked out, or null on a detached `HEAD`.
 */
export class UncommittedChanges extends Schema.TaggedError<UncommittedChanges>()(
  'UncommittedChanges',
  { branch: Schema.NullOr(Schema.String) }
) {}

/** Reads the {@link BranchList} of the git repository at `directory`. */
export const ReadBranches = Rpc.make('ReadBranches', {
  payload: { directory: Schema.String },
  success: BranchList,
  error: GitCallFailed
})

/**
 * Checks out local branch `branch` in the checkout at `directory`, creating it to track the remote
 * branch of that name when only a remote has one, and returns the new {@link BranchList}. Refused
 * with {@link UncommittedChanges} while tracked files have changes; untracked files do not count.
 */
export const SwitchBranch = Rpc.make('SwitchBranch', {
  payload: { directory: Schema.String, branch: Schema.String },
  success: BranchList,
  error: Schema.Union([UncommittedChanges, GitCallFailed])
})
