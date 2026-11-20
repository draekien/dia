---
status: accepted
date: 2026-11-20
decision-makers: William Pei
---

# Creator mode threads change dia on a worktree branch of the meta repo, and the user merges them

## Context and Problem Statement

dia's agents can already load plugin code from any folder with `plugin_override` and `plugin_reload` (ADR-0020), but nothing is dedicated to building dia itself. ADR-0025 has meta agents change the meta repo on a branch in a new worktree, with the user approving each merge. ADR-0036 (as amended by ADR-0064) routes plugin changes through the decision queue by `propose_change`, which does not exist yet (#43). The user wants a Creator mode: threads, started by the user, that build dia plugins and skills and let the user see and undo each turn's changes. Where does a Creator thread work, and how do its changes reach every agent?

## Decision Drivers

* Every change to the harness has a git history the user can review and revert (`PRODUCT.md`, "Improvements are reviewable").
* Two Creator threads open at once must not mix or revert each other's commits.
* A Creator agent tests a plugin by loading it into the running app.
* `propose_change` and the decision queue do not exist yet.

## Considered Options

* A worktree of the meta repo per thread, merged into the meta repo's branch by the user
* Commit directly on the meta repo's branch
* Wait for `propose_change` (#43)

## Decision Outcome

Chosen option: "a worktree of the meta repo per thread, merged into the meta repo's branch by the user", because it follows ADR-0025's worktree rule, keeps each thread's commits on its own branch, and needs no part of ADR-0036 that is not built.

* The `dia-creator` plugin opens each Creator run with `Runs.open` and a `Create` worktree request, so the worktree is a run worktree in dia-worktrees' ledger (ADR-0073) on a `dia/<slug>` branch.
* A Creator agent may point `plugin_override` at a folder in its worktree, so the plugin runs in the app before the merge.
* Each turn's footer lists the commits the turn made on the branch and the plugins it loaded, with Revert. The newest turn with commits shows how many commits are not merged, with Merge.
* Merge makes a merge commit on the meta repo's current branch and moves every plugin override inside the worktree to the same folder in the meta repo.
* At startup dia-creator reattaches the worktrees of unmerged Creator threads, because dia-worktrees removes a clean worktree when its run ends.
* Creator tabs are owned by `dia-creator` and listed in the sidebar's Meta group through dia-threads' `MetaThreadSourcesSlot`.

The design is `docs/designs/creator-mode.md`. This ADR extends ADR-0025 (a Creator thread is a meta agent the user starts and merges from), amends ADR-0036 as amended by ADR-0064 (plugin code from a Creator thread may run before the user reviews it, until `propose_change` exists), extends ADR-0073 (Creator worktrees are reattached at startup while unmerged), and extends ADR-0081 (a plugin may list its owned tabs in the Meta group).

### Consequences

* Good, because each turn's commit range and each revert hold only that thread's commits.
* Good, because a skill a Creator writes reaches other runs only after the merge.
* Bad, because a plugin overridden into a worktree runs in every agent's session before the merge.
* Bad, because deleting an unmerged thread removes its worktree, and an override into it then fails to load until the user clears it on Settings › Plugins.

## Pros and Cons of the Options

### A worktree of the meta repo per thread, merged by the user

* Good, because it matches ADR-0025.
* Bad, because overrides into a worktree must be moved at merge and survive the worktree's removal at quit.

### Commit directly on the meta repo's branch

* Good, because there is no merge step and overrides point at the meta repo from the start.
* Bad, because two threads with overlapping turns attribute each other's commits to both turns and can revert each other's work.
* Bad, because it contradicts ADR-0025's worktree rule.

### Wait for `propose_change`

* Good, because changes would follow the user's per-type tiers.
* Bad, because #43 is not built, and Creator mode would wait for it.
