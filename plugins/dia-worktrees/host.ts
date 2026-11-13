import {
  GitKey,
  type GitOps,
  type HostPluginContext,
  type PluginSetup,
  WorktreesKey
} from '@dia/plugin'
import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Path } from 'effect'
import { DiscardWorktree, KeepWorktree, WatchWorktrees } from './calls'
import { repairWorktrees } from './folder-move'
import { type GitCommands, makeGitOps } from './git-ops'
import { type Ledger, makeLedger, worktreeMigrations } from './ledger'

/**
 * Composes `git` and `ledger` into the {@link GitOps} the plugin provides: every create, reattach
 * and release is recorded in the ledger.
 */
export const recordingGitOps = (git: GitCommands, ledger: Ledger): GitOps => ({
  ...git,
  createWorktree: (sourceRepo, owner, nameHint) =>
    git
      .createWorktree(sourceRepo, owner, nameHint)
      .pipe(Effect.tap((info) => ledger.recordCreated(info, owner))),
  reattachWorktree: (info, paneId) =>
    git
      .reattachWorktree(info, paneId)
      .pipe(Effect.tap((attached) => ledger.recordReattached(attached, paneId))),
  releaseWorktree: (info, paneId) => ledger.release(info, paneId, git.releaseWorktree(info, paneId))
})

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(worktreeMigrations)
    const ledger = yield* makeLedger(sql)
    yield* ctx.onPathsMoved((move) =>
      Effect.gen(function* () {
        yield* repairWorktrees(yield* ledger.movePaths(move), yield* makeGit)
      }).pipe(Effect.provide(NodeServices.layer))
    )
    const root = (yield* Path.Path).join(ctx.dataDir, 'trees')
    yield* ctx.serve(WatchWorktrees, () => ledger.changes)
    yield* ctx.serve(KeepWorktree, ({ path }) => ledger.keep(path))
    yield* ctx.whenProvided([GitKey], ({ git: provided }) =>
      Effect.gen(function* () {
        const git = yield* makeGitOps(root, provided).pipe(Effect.provide(NodeServices.layer))
        yield* ctx.serve(DiscardWorktree, ({ path }) =>
          ledger.discard(path, git.forceRemoveWorktree)
        )
        yield* ctx.provide(WorktreesKey, recordingGitOps(git, ledger))
        yield* Effect.logInfo('Worktrees service provided', { plugin: ctx.name, root })
      })
    )
  }).pipe(Effect.provide(NodeServices.layer))

export default setup
