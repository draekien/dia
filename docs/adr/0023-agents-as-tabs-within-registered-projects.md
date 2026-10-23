---
status: "accepted"
date: 2026-10-23
decision-makers: William Pei
---

# Organise agents as tabs within registered projects, replacing the split-pane layout

## Context and Problem Statement

dia's MVP (`docs/prds/mvp.md`, user stories 1, 2 and 9) is a split-pane workspace: `src/shared/domain/pane-tree.ts` holds a tree of up to 6 visible panes, and each pane has only a `cwd` and an optional `worktree` (`src/shared/domain/pane.ts`). The product has changed (`PRODUCT.md`): the user no longer watches agents while they work, agents run in the background and notify the user when they need input, and a meta project (ADR-0025) needs a fixed list of every project the user works on. How is the window laid out, and what groups agents?

## Decision Drivers

* The user watches agents less and less; dia must work without the user looking at any agent.
* An agent that is not on screen must keep running.
* The meta project and the agent overview need a list of projects that exists before any agent runs in them.
* Projects that are not git repos (for example a notes directory) must be usable.

## Considered Options

* Layout: tabs, one visible at a time
* Layout: an agent list with optional split panes
* Layout: an inbox of agents waiting for input as the main view
* Layout: keep the split-pane grid
* Grouping: any directory the user registers
* Grouping: a git repo the user registers
* Grouping: projects inferred from each agent's `cwd`

## Decision Outcome

Chosen options: "tabs, one visible at a time" and "any directory the user registers", because the user chose them (2026-10-23) after deciding that watching agents is no longer the product's purpose.

| Concept | Definition |
| --- | --- |
| Project | A directory the user registers with dia. Worktree features apply only when it is a git repo |
| Tab | One agent in one project. The agent runs in the project directory or, for a git repo, in one of its worktrees |
| Visible tab | Exactly one tab fills the content area at a time. There are no split panes. Tabs are selected from the agent overview, a left sidebar; there is no separate tab strip |
| Background tab | A tab that is not visible. Its agent keeps running, and its status shows in the agent overview and OS notifications (`docs/prds/agent-os.md`) |
| Archive | Removes the tab's worktree and keeps its session transcripts. The tab moves to its project's archived list |
| Delete | Removes the tab's worktree and its session transcripts |

The persisted state that ADR-0011 calls the layout tree becomes a list of projects, each with its tabs, plus the visible tab. Transcripts stay in the SDK session store (ADR-0011).

This ADR does not rename `pane` in code. The plugin platform's Phase 4 step 6 (`docs/plans/2026-10-22-plugin-platform.md`) replaces the split layout with the tab layout as a built-in plugin.

### Consequences

* Good, because the window shows one agent at full size, and the agent overview replaces watching several panes.
* Good, because the meta project gets its project list from the registry, not from whichever agents happen to be running.
* Bad, because `src/shared/domain/pane-tree.ts`, `src/renderer/src/components/pane-tree-view.tsx` and their tests are replaced, and MVP user stories 1, 2 and 9 no longer hold.
* Bad, because two agents can no longer be seen side by side.

## Pros and Cons of the Options

### Layout: tabs, one visible at a time

* Good, because it matches background-first use: one agent in view, the rest reported through status.
* Bad, because comparing two agents' output means switching tabs.

### Layout: an agent list with optional split panes

* Good, because it keeps the existing split code.
* Bad, because it keeps a feature the product no longer centres on, and every layout plugin must support both modes.

### Layout: an inbox of agents waiting for input as the main view

* Good, because it opens on the agents that block on the user.
* Bad, because it is a filtered view of the agent overview, and can be added later as one. It is on the roadmap.

### Layout: keep the split-pane grid

* Good, because nothing changes.
* Bad, because the grid is built for watching up to 6 agents, which is no longer the product's purpose.

### Grouping: any directory the user registers

* Good, because non-repo directories can be projects.
* Bad, because worktree controls must be hidden for projects that are not git repos.

### Grouping: a git repo the user registers

* Good, because every project supports worktrees.
* Bad, because non-repo directories cannot be projects.

### Grouping: projects inferred from each agent's `cwd`

* Good, because there is nothing to register.
* Bad, because a project does not exist until an agent runs in it, so the meta project has no fixed list.

## More Information

* Related: ADR-0011 (persisted layout), ADR-0019 (layout as a built-in plugin), ADR-0024 (background agents), ADR-0025 (meta project), `docs/prds/agent-os.md`.
* Supersedes MVP user stories 1, 2 and 9 in `docs/prds/mvp.md`.
