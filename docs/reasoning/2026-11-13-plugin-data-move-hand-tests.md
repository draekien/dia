# Moving a plugin data folder: transcripts resume, worktrees repair, fsmonitor blocks the rename

**Date:** 2026-11-13

## Context

ADR-0078 moves plugin data folders and left two claims unverified: that Claude Code finds a session after its transcript folder is renamed, and that `git worktree repair` restores worktrees moved together with their parent folder on Windows. Both were tested by hand on Windows 11 with Claude Code CLI and Git for Windows, in throwaway folders.

## Reasoning / Learning

* Transcripts: a `claude -p --model haiku` session was started in `<dir>\a-old`. The directory was renamed to `dia-a-new` and `~/.claude/projects/<encoded a-old>` to `<encoded dia-a-new>` (the encoding replaces every character outside `[A-Za-z0-9]` with `-`, for example `F--Dev--worktrees-...--handtest-a-old`). `claude -p --resume <id>` from the new directory answered from the earlier turn with the same session id. The transcript then held entries with both `cwd` values; the old ones do not stop the resume.
* Worktrees: a repository with two worktrees under `plugins\worktrees\trees` was moved by renaming `plugins\worktrees` to `plugins\dia-worktrees`. `git worktree list` showed the old paths as `prunable`. `git worktree repair <new path> <new path>` run in the main repository printed `gitdir incorrect` for each and fixed both links: `git worktree list` showed the new paths and `git status` worked inside a moved worktree.
* The rename first failed with `Permission denied` / `EPERM` from `mv`, PowerShell `Rename-Item` and Node `fs.renameSync`. The user's global git config sets `core.fsmonitor=true`, so `git worktree add` started a `git fsmonitor--daemon` for each worktree, and each daemon holds a handle on its worktree, which blocks renaming any ancestor folder. A plain folder next to it renamed fine. `git fsmonitor--daemon stop` in each worktree made the rename succeed. The daemons outlive dia and Claude Code, so they are running when a new dia version starts.

## Implication

A data migration whose folder contains git repositories or worktrees stops their fsmonitor daemons in a `before` step (`plugins/dia-worktrees/data-migration.ts`, `plugins/dia-meta/data-migration.ts`). Any other process with a file or working directory inside the folder (an editor, a terminal, a `claude` process) also makes the rename fail; the plugin then does not load, and the error names both paths and the cause.
