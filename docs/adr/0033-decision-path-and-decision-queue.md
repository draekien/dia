---
status: "accepted"
date: 2026-10-28
decision-makers: William Pei
---

# Review objective plans as a live decision path, and route everything that waits on the user through one decision queue

## Context and Problem Statement

Agents break an objective into tasks and sub-tasks (`docs/prds/org.md`). The user approves the breakdown before work starts, and wants to find the point where a plan goes wrong and have the team re-plan from there with guidance. A 14-task list does not show that point: a wrong plan usually starts with one wrong choice, such as "fetch the index by scraping HTML", and every later task inherits it. What does the user review, how does a correction work, and what happens to choices agents make after approval?

## Decision Drivers

* The user must find the first wrong choice without reading every task.
* A correction must discard the work that depended on the wrong choice and keep the work before it.
* Work must not move past a choice the user has not seen (`PRODUCT.md`, principle "Steer decisions, not tasks").
* Plans, new choices, `ask` permissions and harness changes all block agents on the user, and must be found in one place.

## Considered Options

* A dependency graph of tasks
* A milestone list
* A prose summary written by the lead agent
* A decision path, reviewed once
* A decision path that stays live after approval, pausing the agent at each new decision
* A decision path that stays live, without pausing the agent

## Decision Outcome

Chosen option: "a decision path that stays live after approval, pausing the agent at each new decision", because the user reviews the choices the tasks depend on, a correction has a defined point to restart from, and no work continues past a choice the user has not seen.

### Decision path

Agents call `record_decision` for each choice the plan depends on. A decision has a question, the chosen answer, the rejected alternatives, a confidence, the tasks that depend on it, and the commit of each affected task branch when it was recorded.

```text
Ship plugin marketplace                      3 agents · 14 tasks

 ◆ Where does the index live?
 │   ✓ JSON file in a GitHub repo          rejected: npm registry, own server
 ◆ How does dia fetch it?                  ⚠ low confidence
 │   ✓ scrape the repo's HTML              rejected: GitHub API (rate limits)
 ◆ Where does the UI go?
 │   ✓ new feature plugin, own page        rejected: section in plugin panel
 ◆ How does install work?
     ✓ git clone into the overrides folder
```

| Action | Effect |
| --- | --- |
| Approve | Work starts on the tasks |
| Cut at a decision, with guidance or a rejected alternative | Decisions before it are kept. Tasks that depend on it or on later decisions are discarded. Each affected task branch is reset to the commit recorded with the decision, and the discarded commits are kept on a backup ref. The planner re-plans from the decision with the guidance |
| A new decision during the work | The agent pauses. The decision appears on the path as unreviewed and in the decision queue. Accept continues the agent; cut applies the cut action |

Every objective's plan goes through review, whether the user assigned it or the objective watcher picked it up. Tasks created by a routine skip review.

### Decision queue

One list of items that block an agent on the user: plans to review, unreviewed decisions, permission requests from a role's `ask` list, and harness changes that wait for approval (ADR-0035). An item in the queue raises the same notification as a permission request.

### Consequences

* Good, because the user reads 4 decisions instead of 14 tasks to judge a plan.
* Good, because a cut has a defined restart point and keeps the earlier work.
* Good, because the backup ref makes a cut recoverable.
* Bad, because agents must call `record_decision` reliably; a choice an agent does not record cannot be reviewed or cut. Role instructions must say when to record.
* Bad, because pausing at every new decision can block work often; the number of pauses is measured by the org KPI "time waiting on the user".

## Pros and Cons of the Options

### A dependency graph of tasks

* Good, because it shows every dependency.
* Bad, because the user must read every node to find the wrong choice.

### A milestone list

* Good, because it is short.
* Bad, because a milestone states an outcome, not the choice that leads to it.

### A prose summary

* Good, because it is the fastest to read.
* Bad, because the user cannot tell which tasks a sentence covers, so a cut has no defined effect.

### A decision path, reviewed once

* Good, because agents are never paused after approval.
* Bad, because choices made during the work are never reviewed.

### A decision path that stays live, without pausing

* Good, because agents never wait.
* Bad, because a cut made later discards all the work done after the decision.

## More Information

* Related: ADR-0032 (org), ADR-0035 (harness changes in the queue), `docs/prds/org.md`.
* The decision path and decision queue screens are designed with `/impeccable` against `DESIGN.md` before they are wired to real data.
