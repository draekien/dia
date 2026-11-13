---
status: "accepted"
date: 2026-11-13
decision-makers: William Pei (delegated; taken without the user during the foundation rewrite)
---

# Org runs hires and the Executive assistant as runs of `dia-runs`

## Context and Problem Statement

ADR-0076 rewrites org over the foundation. ADR-0071 has the Executive assistant as a session org attaches, in `dontAsk`, with its job title's MCP servers and allow list; ADR-0064 and ADR-0069 give each hire's session its job title's job description, MCP servers, skills and allow list. `Runs.start` (ADR-0074), the only way the run queue starts a run, takes a directory, model, thinking level, permission mode, first message, labels and context, and nothing else. How does org start its runs?

## Decision Drivers

* ADR-0076: org contains no session runner, permission queue or scheduler.
* An issue starts through the run queue with a per-hire limit of 1.
* No change to the foundation plugins in this step.

## Considered Options

* Runs through `Runs.start` as it is: a job title sets the options it can, and its job description leads the first message
* Extend `StartRunOptions` and the stored run with a system prompt append, plugin paths and session tool options first

## Decision Outcome

Chosen option: "Runs through `Runs.start` as it is", because it needs no foundation change, and the extension can follow without changing org's shape.

* A hire's run and the assistant's run start in the permission mode `startPermissionMode` (ADR-0054) gives. The assistant no longer runs in `dontAsk` (amends ADR-0071).
* A job title's job description is the first paragraph of the run's first message. Its MCP servers, skills and allow and deny lists are not applied to runs until `StartRunOptions` carries them (amends ADR-0064 and ADR-0069 option B).
* The Executive assistant is a run org starts on the user's first request and shows in a tab through `OpenRunInTab`; Start over archives it. It is not an attached session (amends ADR-0071, "The session"). Notices are prefixed to the next request sent through the Org page; they are not shown in the run's transcript (amends ADR-0071, "Notices").

### Consequences

* Good, because org is a composition of `dia-issues`, `dia-runs`, `dia-run-queue` and `dia-tools`, as ADR-0076 requires.
* Bad, because dia tool calls of a run in `default` mode ask the user each time, since no allow list is applied.
* Bad, because a job title's MCP servers and skills shown in its editor have no effect until the follow-up.

## More Information

Spec: `docs/designs/dia-org.md`.
