---
status: "accepted"
date: 2026-10-28
decision-makers: William Pei
---

# Let agents change the harness through `propose_change`, applied by a risk tier the user sets per change type

## Context and Problem Statement

ADR-0025 lets project agents file proposals with `meta_propose`; a meta agent combines them into branches, and the user approves every merge. `docs/prds/org.md` widens what agents may change (memory, skills, roles, workflows, tools and plugins) and adds a retro after every task (ADR-0035) that finds improvements from the task's transcripts. Approving every change makes the user the bottleneck, and applying every change at once lets a wrong plugin reach every agent. Which changes apply at once, and who decides?

## Decision Drivers

* A change that affects every agent must be recorded and revertible (`PRODUCT.md`, principle "Improvements are reviewable").
* Text that agents read is easy to revert; code that runs can do damage before it is reverted.
* The user knows which risks they accept better than a fixed rule does.

## Considered Options

* Every change through one approval queue
* Fixed tiers: instructions apply at once, code waits for approval
* Only memory applies at once
* Tiers the user configures per change type, with fixed tiers as the default
* Plugin changes only as pull requests to the dia repo

## Decision Outcome

Chosen option: "tiers the user configures per change type, with fixed tiers as the default", because the default keeps code changes reviewed, and the user can move a change type between tiers as trust grows.

### Change types and default tiers

| Change type | Default tier |
| --- | --- |
| Long-term memory | Apply at once (written by the retro with `memory_write`, ADR-0035) |
| Skills, including scripts bundled in a skill | Apply at once |
| Role instructions | Apply at once |
| Workflows | Decision queue |
| Tools | Decision queue |
| Plugins | Decision queue |
| Hooks | Decision queue |
| Role permissions, model and concurrency | Decision queue |

* Apply at once: the change is committed and listed in a change log, from which the user can revert it.
* Decision queue: the change waits in the decision queue (ADR-0034) with the transcripts that motivated it, and applies when the user approves it.
* The user sets the tier of each change type in settings. `memory_write` and `propose_change` both follow the tier of the change type they carry.

### `propose_change`

`propose_change` replaces `meta_propose` from ADR-0025. It takes the change type, the change, and the tasks or transcripts that motivated it. The retro and meta agents call it. A change made in a git repo, the meta repo or dia, is made on a branch in a new worktree of that repo, as ADR-0025 defines for meta agents.

A tool an agent builds is a plugin that registers a dia tool, so it follows the tier for plugins.

### Amendment to ADR-0025

* Step 1 of ADR-0025's improvement loop ("an agent in a project calls `meta_propose`") is replaced by the retro, which reads the task's transcripts and calls `propose_change`.
* Step 3 of ADR-0025's improvement loop (a meta agent combines open proposals into a branch) is replaced: proposals apply by their tier with no meta agent between the retro and the user. A meta agent, started by the user or by a routine, reads the change log and the decision queue, merges duplicate changes, resolves conflicting ones and reverts changes that did not reduce waste. Its own changes follow the tiers.
* "The user approves or rejects each branch" now applies only to change types in the decision queue tier.
* Meta agents can be started by a routine as well as by the user.

### Consequences

* Good, because most improvements (memory, skills, instructions) reach agents without waiting for the user.
* Good, because each change type can be trusted separately.
* Bad, because a user who sets plugins to apply at once lets an agent-written plugin run before review.
* Bad, because a skill can bundle scripts, and under the default tier a skill script written by an agent runs before review. The user accepted this risk; moving skills to the decision queue tier removes it.
* Bad, because the change log and revert must work for every change type in the apply-at-once tier.

## Pros and Cons of the Options

### Every change through one approval queue

* Good, because nothing applies unreviewed.
* Bad, because the user approves every memory entry and skill edit.

### Fixed tiers

* Good, because there is nothing to configure.
* Bad, because the user cannot move a change type as trust grows.

### Only memory applies at once

* Good, because a bad skill cannot reach every agent of a role unreviewed.
* Bad, because skill edits, the most common improvement, all wait for the user.

### Plugin changes only as pull requests to the dia repo

* Good, because plugin changes go through the dia release process.
* Bad, because an improvement waits for a release, and plugins outside the dia repo have no path.

## More Information

* Amends: ADR-0025.
* Related: ADR-0020 (plugin overrides), ADR-0034 (decision queue), ADR-0035 (retro), `docs/prds/org.md`.
