# `importTab` keeps an existing tab unchanged, so a run placement cannot backfill its owner

**Date:** 2026-11-15

## Context

ADR-0081 adds `owner` to tabs and projects. Issue-run tabs opened by #282, and the `assistant` project the dashboard's `Show the Executive assistant` registered, exist without an owner. `PaneWorkspace.showRunInTab` builds a tab with `owner` and passes it to `importTab`, and the backfill was expected to happen there.

## Reasoning / Learning

`importTab` (`src/host/services/pane-workspace.ts`) returns the workspace unchanged when `WorkspaceOps.tabOf` already finds the pane id. A run that already has a tab therefore keeps its old name and gets no owner, and the tab stays in the thread list. Changing `importTab` to overwrite was ruled out: `workspace-problems.ts` also calls it to import a skipped tab, where an existing tab must win.

`showRunInTab` instead calls `WorkspaceOps.claimTab(workspace, paneId, owner, name)` after `importTab` when the placement has an owner. `claimTab` sets the tab's owner and name only when the tab has no owner, sets the project's owner only when `owner.ownsProject` is true and the project has none, and returns the same workspace object when nothing changes, so `mutate` does not store or publish a no-op.

## Implication

To change a field of a tab that may already exist, add a `WorkspaceOps` function and call it through `mutate` after `importTab`; do not rely on `importTab` to update a tab.
