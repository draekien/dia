# Resuming a pane's worktree: reattach, never recreate (and never `-B`)

**Date:** 2026-07-17

## Context

Bullet 05 (persistence & restart restore) needs a worktree pane to come back at its
*exact* original `cwd` after a restart, because the Agent SDK keys each session's
transcript by `<encoded-cwd>` (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). If
the pane's `cwd` differs by even one character on resume, `resume: sessionId` silently
starts a fresh session instead of continuing the old one.

dia removes worktrees on graceful shutdown (via the `acquireRelease` finalizer in
`PaneSupervisor.openPane`) but the branch persists. So on resume the directory is gone but
the branch — with the pane's committed work — is still there.

> **Update (2026-07-19):** worktree branches/dirs are now named `dia/<adjective-noun>` (a
> friendly, collision-checked slug from `GitOpsService.createWorktree` — see
> `worktree-slug.ts`), not `dia/<paneId>`. The branch string is no longer derivable from the
> pane id, so reattach must read the **persisted** `WorktreeInfo.branch` rather than
> reconstruct it. `PaneCreationRequest.worktree` is now a discriminated `Create`/`Reattach`
> union carrying that persisted info; `openPane` no longer rebuilds `dia/<paneId>` on resume
> (it used to, which would have silently broken resume once names became slugs). The `<paneId>`
> examples below are kept verbatim as originally verified against git — read them as `<branch>`.

## Reasoning / Learning

The three `git worktree add` forms are **not** interchangeable here (verified against git
2.47.1.windows.2):

- `git worktree add <path> -b dia/<paneId>` — the *create* incantation. On resume it
  **fails**: `fatal: a branch named 'dia/pane-123' already exists`. This is what
  `createWorktree` uses, and why a naive "just call createWorktree again" breaks resume.
- `git worktree add <path> dia/<paneId>` (no `-b`) — the *reattach* incantation. Checks
  out the existing branch into a fresh worktree dir, restoring the pane's committed work
  intact. **This is the correct resume path** (`GitOpsService.reattachWorktree`).
- `git worktree add -B dia/<paneId> <path>` — **never use this.** `-B` force-*resets* the
  branch to HEAD, silently discarding every commit the pane made. It looks like a
  convenient "reattach or create" one-liner and is a data-loss trap.

Reattach must also be **guarded**: `git worktree add` fails if `<path>` already exists, so
`reattachWorktree` checks `FileSystem.exists(path)` first and no-ops when the dir is
present (already-live pane, or a crash-orphaned dir). resume-on-focus is likewise a no-op
when the pane already has a live handle in `PaneSupervisor`.

## Implication

- Resume is a distinct git operation from create — `PaneSupervisor.openPane` branches on
  `request.resume` to call `reattachWorktree` vs `createWorktree`. Don't collapse them.
- If a future bullet adds crash recovery for dir-present-but-unregistered worktrees, the
  fix is `git worktree prune` before reattach — **not** `-B`, which would destroy the very
  work crash recovery is meant to save.
- Any change to how a worktree pane's `cwd` is derived is a resume-correctness change:
  the path must stay byte-identical across restarts or the SDK loses the transcript.
