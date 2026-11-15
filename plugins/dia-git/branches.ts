import type { Git, GitError, GitRef } from '@dia/plugin'
import { Effect, Option } from 'effect'
import {
  type Branch,
  type BranchList,
  DetachedHead,
  GitCallFailed,
  OnBranch,
  UncommittedChanges
} from './calls'

const LOCAL_PREFIX = 'refs/heads/'
const REMOTE_PREFIX = 'refs/remotes/'
const DEFAULT_REMOTE = 'origin'
const SHORT_COMMIT = 7

const failed = (error: GitError) => new GitCallFailed({ reason: error.message })

const localBranch = (ref: GitRef): Branch => ({
  name: ref.name.slice(LOCAL_PREFIX.length),
  remote: null
})

const remoteBranch = (ref: GitRef): Branch => {
  const name = ref.name.slice(REMOTE_PREFIX.length)
  return { name, remote: name.split('/')[0] ?? '' }
}

const isRemoteHead = (ref: GitRef) => ref.name.endsWith('/HEAD')

/**
 * Reads the {@link BranchList} of the repository at `directory` through `git`. Fails with
 * {@link GitCallFailed} when git cannot read it.
 */
export const readBranches = Effect.fn('Branches.read')(function* (git: Git, directory: string) {
  const [current, localRefs, remoteRefs, originHead] = yield* Effect.all(
    [
      git.currentBranch(directory),
      git.refs(directory, LOCAL_PREFIX),
      git.refs(directory, REMOTE_PREFIX),
      git.remoteHead(directory, DEFAULT_REMOTE)
    ],
    { concurrency: 'unbounded' }
  )
  const head = Option.isSome(current)
    ? OnBranch.make({ branch: current.value })
    : DetachedHead.make({
        commit: Option.getOrElse(yield* git.resolveCommit(directory, 'HEAD'), () => '').slice(
          0,
          SHORT_COMMIT
        )
      })
  const local = localRefs.map(localBranch)
  const remote = remoteRefs.filter((ref) => !isRemoteHead(ref)).map(remoteBranch)
  const checkedOut = Option.getOrNull(current)
  const branches: BranchList['branches'] = [
    ...local.filter((branch) => branch.name === checkedOut),
    ...local.filter((branch) => branch.name !== checkedOut),
    ...remote
  ]
  yield* Effect.logDebug('Read branches', { directory, count: branches.length })
  return {
    head,
    defaultBase: Option.getOrElse(originHead, () => checkedOut),
    branches
  } satisfies BranchList
}, Effect.mapError(failed))

const hasTrackedChanges = (git: Git, directory: string) =>
  git.status(directory).pipe(Effect.map((entries) => entries.some((entry) => entry.code !== '??')))

/** The local branch name `git switch` takes for `branch`: a remote branch without its remote. */
export const localName = (branch: Branch): string =>
  branch.remote === null ? branch.name : branch.name.slice(branch.remote.length + 1)

/**
 * Checks out `branch` in the checkout at `directory` through `git`, as the local branch of the same
 * name when it is a remote branch, and returns its new {@link BranchList}. Fails with {@link UncommittedChanges} when tracked files have changes, and
 * with {@link GitCallFailed} when git refuses the switch.
 */
export const switchBranch = Effect.fn('Branches.switch')(function* (
  git: Git,
  directory: string,
  branch: Branch
) {
  if (yield* hasTrackedChanges(git, directory).pipe(Effect.mapError(failed))) {
    const current = yield* git.currentBranch(directory).pipe(Effect.mapError(failed))
    yield* Effect.logInfo('Refused a branch switch over uncommitted changes', {
      directory,
      branch: branch.name
    })
    return yield* new UncommittedChanges({ branch: Option.getOrNull(current) })
  }
  const name = localName(branch)
  yield* git.switchBranch(directory, name).pipe(Effect.mapError(failed))
  yield* Effect.logInfo('Switched the checkout branch', { directory, branch: name })
  return yield* readBranches(git, directory)
})
