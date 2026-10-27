---
status: "accepted"
date: 2026-10-28
decision-makers: William Pei
---

# Run one org of hired agents with roles, per-role and overall concurrency caps, and ad-hoc tabs outside the caps

## Context and Problem Statement

`docs/prds/org.md` adds objectives that a team of agents plans and works on. Today every agent is a tab the user starts by hand (ADR-0023). dia needs a model for who does the work: what the user hires, where hired agents may work, how many run at once, and how the existing tabs relate to the org.

## Decision Drivers

* Work arrives in many registered projects; an agent that is idle in one project should be able to take work in another.
* Memory must be shared by project, environment and role (ADR-0034), not split per agent.
* The user must be able to limit concurrency per kind of work and overall.
* A quick question in a tab must never wait behind org work.

## Considered Options

* What is hired: a role template; named employees with their own memory; a role with named employees on top
* Org scope: one org across all projects; one org per project; one org with agents assigned to projects
* Ad-hoc tabs: kept outside the caps; kept and counted in the caps; removed in favour of conversations with hired agents

## Decision Outcome

Chosen options: "a role with named employees on top", without per-employee memory; "one org across all projects"; and "kept outside the caps", because they let any idle agent take any task, keep memory in shared scopes, and leave today's tabs unchanged.

### Model

| Concept | Definition |
| --- | --- |
| Org | One per dia installation. Spans every registered project |
| Role | Instructions, skills, MCP servers, and an optional allow/ask/deny permission list. An empty list allows every tool |
| Built-in roles | `planner`, `engineer`, `reviewer`, `researcher`, `retro`. The user can disable, copy and edit each one |
| Hired agent | A role plus an optional name. Has no memory of its own |
| Per-role cap | The number of hired agents of that role |
| Overall cap | A number the user sets. Limits how many hired agents run at once across all roles |
| Objective watcher | The role the user sets to pick up unassigned objectives. Default: `planner` |
| Hired agent session | Opens from the agent overview like a tab: live transcript and the composer with `queue` and `steer` (`docs/designs/message-queue-and-steer.md`), so the user can check and correct a task while it runs |
| Ad-hoc tab | A tab the user opens directly. Not a hired agent. Never counted toward a cap and never queued |

Example: with an overall cap of 4 and hired agents `Ada` and `Ben` (engineer), `Cy` (reviewer) and one unnamed `retro`, at most 2 engineer tasks run at once, and at most 4 hired agents run at once in total.

### Scheduling

* Retro and planner sessions are hired agents and count toward the caps.
* On first run, dia hires one agent of the objective watcher role and one `retro`. The user can dismiss them. While the objective watcher role or `retro` has no hired agent, the org screen shows a warning, unassigned objectives wait for an objective watcher, and finished tasks wait for a retro.
* When a cap is full, waiting tasks start by objective priority, then oldest first.
* A hired agent that finishes a task takes the next waiting task its role can do, in any project.

### Consequences

* Good, because an idle agent never waits for work that exists in another project.
* Good, because raising a role's concurrency is the same action as hiring.
* Good, because ad-hoc tabs keep the behaviour ADR-0023 defined.
* Bad, because ad-hoc tabs and hired agents share one machine and one Claude plan, and the overall cap does not limit their sum.
* Bad, because a name on a hired agent carries no memory of its own, which users may expect from the word "hire".

## Pros and Cons of the Options

### What is hired: a role template

* Good, because it is the simplest model.
* Bad, because the user cannot tell two running agents of one role apart.

### What is hired: named employees with their own memory

* Good, because each agent builds its own history.
* Bad, because memory is split between employees, so what one learns does not reach the others.

### What is hired: a role with named employees on top

* Good, because agents are distinguishable and memory stays shared by role.
* Bad, because a hire is one more object to manage than a role alone.

### Org scope: one org per project

* Good, because each project's team is easy to see.
* Bad, because agents in quiet projects sit idle and the user hires again in every project.

### Org scope: one org with agents assigned to projects

* Good, because the user can reserve agents for a project.
* Bad, because it adds an assignment the user maintains, for a need not yet seen.

### Ad-hoc tabs: kept and counted in the caps

* Good, because the overall cap limits every agent.
* Bad, because a quick question waits, or the user pauses org work to ask it.

### Ad-hoc tabs: removed

* Good, because all work goes through one model.
* Bad, because it removes the main way dia is used today.

## More Information

* Related: ADR-0023 (tabs within projects), ADR-0033 (decision path), ADR-0034 (memory), `docs/prds/org.md`.
* Open: whether a hired agent holds a slot only while a turn runs, or for the whole time it is assigned an open task (`docs/prds/org.md`, Open Questions).
