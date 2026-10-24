# A worktree removed at quit leaves an empty directory, and resume then skips the reattach

**Date:** 2026-10-24

## Context

While verifying Phase 4 step 4 (`git-ops` plugin), a packaged build created a worktree pane, completed a turn, and was quit gracefully (`Browser.close` over CDP). The next launch resumed the pane's session and the agent remembered the earlier prompt, but `git worktree list` showed no worktree for the pane.

## Reasoning / Learning

- At quit, `GitOps.removeWorktree` ran 135 ms after `Closing query`, and `git worktree remove --force` exited 255. The warning `Standard worktree remove failed, trying with --prune` followed, then `Pruned pane worktree`. The worktree directory had lost its contents but remained on disk as an empty directory; I did not identify which process held it (the likely holder is the exiting `claude` process, whose working directory is the worktree).
- `git worktree prune` removed the registration of the now-incomplete worktree, so the branch `dia/<slug>` exists with no worktree.
- On the next launch `reattachWorktree` found the path present and logged `Worktree path already present; skipping reattach (crash-orphan recovery is out of scope)`. The resumed session started with `cwd` set to the empty directory, so the agent resumed with its transcript but without the repository's files.
- The same sequence occurred on `main` at `a2502a8` (before `git-ops` became a plugin), with identical log lines and exit code 255, so the plugin move did not cause it.
- A `reload` of `git-ops` with a worktree pane open did not break teardown: `closePane` afterwards ran the real removal (`Standard worktree remove failed … exitCode 128`, then prune, 128 because the registration was already gone), not the inert `Left a pane worktree on disk` path.

## Implication

Fixed in `reattachWorktree` (`plugins/git-ops/git-ops.ts`): it lists the repository's worktrees with `git worktree list --porcelain`, skips only a path that is registered, re-adds into an existing empty directory, and fails for a non-empty unregistered directory. In a packaged build the relaunch then showed the pane's worktree registered again. The removal itself still exits 255 on Windows each time (also on `closePane`), so an empty directory stays under the worktrees root after every removal; the cause is not identified.

Options considered before the fix:

- Wait for the session process to exit before `removeWorktree`: not done. It needs an exit signal from `Query.close()`, which was not checked, and it would not repair a worktree left by a crash.
- Make `reattachWorktree` treat an unregistered path as absent: done, as described above. It repairs a failed removal and a crash alike.

Follow-ups on the removal side, not done: skip removal on a quit that will resume (remove only on a permanent `closePane`), or finish the removal before pruning (retry, then delete the directory, and prune only when the directory is gone) so a failed removal does not leave a registered-then-pruned worktree. The reattach fix stays as the backstop for a crash.
