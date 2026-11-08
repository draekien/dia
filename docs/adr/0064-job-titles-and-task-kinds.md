---
status: "accepted, amended by ADR-0069 and ADR-0071"
date: 2026-11-07
decision-makers: William Pei
---

# Name what an agent is hired as a job title, ship seven built-in job titles, and make planning and retro kinds of task

## Context and Problem Statement

ADR-0033 ships the built-in roles `planner`, `engineer`, `reviewer`, `researcher`, `retro` and `router`, and hires one `retro` on first run. ADR-0035 runs every retro as a session of the `retro` role, and ADR-0053 sends route `plan` and every unassigned objective to `planner`. A role named after one activity (`planner`, `retro`) ties that activity to one kind of agent, and the org's vocabulary ("role", "instructions") does not match the hiring vocabulary ADR-0033 already uses ("hire", "dismiss"). What does an agent get hired as, which ones ship, and who plans and runs retros?

## Decision Drivers

* The user decides who plans a piece of work and who reviews a finished task.
* The org's words match one theme: an agent is hired into a job title described by a job description.
* Only internal test databases hold the old built-in roles (#209).

## Considered Options

* Keep the five built-in roles, with planning and retro as roles
* Seven built-in job titles, with planning and retro as kinds of task the user assigns
* Seven built-in job titles, with planning and retro each run by a job title chosen once in Settings

## Decision Outcome

Chosen option: "Seven built-in job titles, with planning and retro as kinds of task the user assigns", because it lets the user pick the agent for each plan and each retro, and no job title exists only to plan or only to review.

### Vocabulary

| Term | Meaning | Replaces |
| --- | --- | --- |
| Job title | What an agent is hired as: a job description, skills, MCP servers, an optional allow/ask/deny permission list and a bypass opt-in (ADR-0054) | role |
| Job description | The text appended to the system prompt of every session of a job title | instructions |
| Hired agent | A job title plus an optional name (ADR-0033) | unchanged |

Amended by ADR-0071: an eighth built-in job title, `Executive assistant`, runs the org's assistant session; it is never hired and never counted.

ADR-0042, ADR-0043, ADR-0054 and ADR-0056 keep the word "role"; read it as "job title". They are not amended.

### Built-in job titles

| Kind | Name | Denies `Edit`, `Write`, `NotebookEdit` |
| --- | --- | --- |
| `product-manager` | Product manager | yes |
| `software-engineer` | Software engineer | no |
| `quality-engineer` | Quality engineer | no |
| `business-analyst` | Business analyst | yes |
| `ui-ux` | UI/UX designer | no |
| `team-lead` | Team lead | yes |
| `technical-lead` | Technical lead | yes |

`router` stays as ADR-0053 defines it: never hired and never counted toward a cap. The user can disable, copy and edit each built-in job title; a built-in job title keeps its name. The seeds are in `plugins/org/built-in-job-titles.ts`.

### Planning and retro

* A planning task breaks an objective into tasks. A retro task reads a finished task's transcripts and scratchpad and writes long-term memory (ADR-0035).
* The user picks the hired agent of each planning task and each retro task, as for any task. No job title is tied to either.
* Route `plan` (ADR-0053) and an objective the user leaves unassigned in the objective form create a planning task, which waits until the user assigns it. (Amended by ADR-0069: every objective creates a planning issue, and an objective with an assignee starts it at once.)
* A finished task waits until its retro task is assigned and done. (Amended by ADR-0069: finishing a `work` issue moves it to `done` and creates its retro issue; it does not wait for the retro.)
* dia hires nobody on first run, and the org shows no "No retro is hired" warning.

### Consequences

* Good, because the user chooses the agent for each plan and each retro.
* Good, because the screens and the code use the same words (`JobTitle`, `jobDescription`).
* Bad, because every plan and every retro waits for the user to assign it, including a plan the router starts.
* Bad, because databases that ran migration `2_seed_org` lose the five old built-in roles and their hires when migration `3_job_titles` runs; the user's copies and their hires are kept.

## Pros and Cons of the Options

### Keep the five built-in roles, with planning and retro as roles

* Good, because no data changes.
* Bad, because a plan always goes to a `planner` and a retro always to a `retro`, whatever the work.

### Seven built-in job titles, with planning and retro as kinds of task the user assigns

* Good, because each plan and retro goes to the agent the user picks.
* Bad, because nothing starts a plan or a retro until the user assigns it.

### Seven built-in job titles, with planning and retro each run by a job title chosen once in Settings

* Good, because plans and retros start without the user assigning each one.
* Bad, because it adds two settings and still ties each activity to one job title.

## More Information

* Amends ADR-0033 (built-in roles, first-run retro, the "No retro is hired" warning, planner and retro sessions as hired agents), ADR-0034 (`planner` in plan review and cutting), ADR-0035 (the retro as a session of the `retro` role), ADR-0036 (the retro calling `propose_change`) and ADR-0053 (every `planner` reference).
* Design: `docs/designs/org-job-titles.md` (#209).
