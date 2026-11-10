---
status: accepted
date: 2026-11-10
decision-makers: William Pei
---

# The worktrees plugin keeps a ledger of every worktree, and org issues run in their own worktree when a project opts in

## Context and Problem Statement

The org dispatcher runs every issue in its project's directory (`plugins/org/dispatcher.ts`), so two hired agents working one project at the same time edit one checkout. Pane worktrees are removed with `git worktree remove --force` at pane close and at quit, which deletes uncommitted edits. Paperclip (`.repos/paperclip`, `server/src/services/workspace-runtime.ts`) gives each issue its own worktree when a project opts in. Where should dia isolate org work, and who decides what happens to a worktree that still holds changes?

## Decision Drivers

* Hired agents in one project must not edit the same checkout.
* No worktree removal may delete modified or untracked files without the user's decision.
* The `issues` plugin stays provider-agnostic (ADR-0072).
* One place lists every worktree dia made and the ones that wait for a decision.

## Considered Options

* A worktree per issue, opt-in per project, with a ledger in the `worktrees` plugin covering panes and issues
* A worktree per objective
* A worktree per hired agent
* A pre-close check on `AssigneeProvider` that asks before Finish

## Decision Outcome

Chosen option: "A worktree per issue, opt-in per project, with a ledger in the `worktrees` plugin covering panes and issues", because each issue then gets its own branch and resumes in its own path, and one plugin owns the release rule and the page that asks the user.

The `GitOps` seam (ADR-0062) changes: `createWorktree(sourceRepo, owner, nameHint)` replaces `createWorktree(sourceRepo, paneId, worktreesRoot)`, `releaseWorktree` replaces `removeWorktree`, and the plugin chooses where new worktrees go. `releaseWorktree` runs `git worktree remove` without `--force`; git refuses a tree with modified or untracked files, and the plugin then records the worktree as needing a decision on Settings › Worktrees. The org plugin releases the worktree of every issue that leaves its startable and started sets. The design is `docs/designs/worktree-ledger.md`.

### Consequences

* Good, because uncommitted edits in pane and issue worktrees are kept until the user discards them.
* Good, because issues of one project run in parallel without sharing a checkout.
* Bad, because new worktrees move from `<userData>/worktrees` to `<userData>/plugins/worktrees/trees`, a longer path on Windows.
* Bad, because the seam change raises `PLUGIN_API_VERSION` from 0.0.35 to 0.0.36, so every shipped `plugin.json` changes.
* Bad, because an issue's agent does not see the user's uncommitted changes in the project directory.

## Pros and Cons of the Options

### A worktree per objective

* Good, because one objective ends as one branch.
* Bad, because hired agents working one objective at the same time still share a checkout.

### A worktree per hired agent

* Bad, because one branch mixes work from unrelated issues, and no event ends the worktree.

### A pre-close check on `AssigneeProvider`

* Bad, because it adds a worktree-specific member to the generic issues contract (ADR-0072), and `objective_stop` runs with no user present to answer.

## More Information

Amends ADR-0062 (the `worktrees` seam shape) and ADR-0072 (the org plugin uses the `worktrees` service).
