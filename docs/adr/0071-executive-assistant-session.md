---
status: "accepted, amended by ADR-0072"
date: 2026-11-08
decision-makers: William Pei
---

# Run one Executive assistant session in the org plugin, and route a direct request to one work issue

## Context and Problem Statement

ADR-0053 takes the user's requests through a built-in `router` role in any number of router tabs in an `Assistant` rail group, and posts a notice in a router session when an objective it created needs the user. ADR-0064 renamed roles to job titles, ADR-0069 made every objective create a planning issue, and ADR-0070 lets a plugin attach a session it opens to the Host. Which job title runs the router, who owns its session, what does route `direct` create, and how does the user learn that work the router started needs them?

## Decision Drivers

* A job title names what an agent is (ADR-0064); "router" names what it does.
* A one-step request starts without a plan (ADR-0053), but ADR-0069 creates a planning issue for every objective.
* ADR-0070 already shows a plugin's session as a rail row with the transcript and composer.
* There is no decision queue yet (ADR-0034 is not built), so a notice cannot link to a queue item.

## Considered Options

* Job title: a built-in `Executive assistant` job title; keep `router` as a role
* Session: one session the org plugin attaches (ADR-0070), with Start over; any number of tabs the user opens and clears (ADR-0053)
* Route `direct`: the objective and one `work` issue for the named hired agent, with no planning issue; the objective and a planning issue assigned to that agent (ADR-0069)
* Notices: a notice in the pane with an Open link, whose text is prefixed to the user's next message; a decision queue item only

## Decision Outcome

Chosen options: "a built-in `Executive assistant` job title", "one session the org plugin attaches", "one `work` issue with no planning issue" and "a notice in the pane", because they reuse the job title, attached session and Org page code that exists, keep a direct request free of planning, and tell the user and the assistant about work in the one chat the user asks in.

### The Executive assistant job title

The org seeds an eighth built-in job title, `Executive assistant` (kind `executive-assistant`). Its allow list is the four routing tools (`objectives_read`, `objective_create`, `objective_attach`, `objective_stop`) and its job description holds ADR-0053's routing rules. It is never hired and never counted toward a cap; `Hire` refuses it with `JobTitleNotHireable`. The user can disable, copy and edit it; a copy is an ordinary job title that can be hired.

### The session

The org plugin attaches one session (ADR-0070) while the built-in Executive assistant job title is enabled, and closes it when it is disabled. The session has no project (`projectId: null`), so the rail shows it in the `Assistant` group above the project groups. It runs in `dontAsk` with the job title's model, thinking level, permissions and MCP servers, in `<plugin data dir>/assistant`. Its session id is stored in the org database and resumed after a restart. Its row menu offers Show and Start over; Start over replaces it with a new session that has an empty transcript. An edit to the job title takes effect at the next start.

### Routes

* Route `direct` creates the objective and one `work` issue in `todo`, titled as the objective and assigned to the named hired agent, with no planning issue. The dispatcher starts it like any assigned issue.
* Route `plan` creates the objective and its unassigned planning issue (ADR-0069), which waits until the user assigns it.

### Notices

While the session runs, the assistant watches the objectives it created. When one of their issues enters `triage` or reaches `in_review`, or the objective completes, it shows a notice in the pane with an Open link to that objective on the Org page, and prefixes the notice text to the user's next message. Notices are not stored: they are lost on restart, disable or Start over.

### Consequences

* Good, because the assistant is a job title the user edits on the Job titles page like any other.
* Good, because the rail row, transcript and composer are ADR-0070's, with no new pane type.
* Good, because a direct request reaches the hired agent with the user's words and no planning step.
* Good, because the model learns what changed on its next turn without polling.
* Bad, because there is one assistant session; a second conversation needs Start over, which hides the first transcript.
* Bad, because a notice raised while the app is closed, or before a restart, is never shown.

## Pros and Cons of the Options

### Keep `router` as a role

* Good, because it matches ADR-0053's words.
* Bad, because dia has no roles since ADR-0064; a role would be a second kind of thing the user configures.

### Any number of tabs the user opens and clears

* Good, because the user can hold separate conversations.
* Bad, because each tab needs a project or a new project-less tab type, and the notices must choose which tab to post in.

### A planning issue assigned to the named agent for route `direct`

* Good, because every objective has the same shape (ADR-0069).
* Bad, because the agent must plan a one-step request before doing it, which ADR-0053's `direct` route exists to avoid.

### A decision queue item only

* Good, because the user acts in one list.
* Bad, because the decision queue is not built, and the assistant would not learn of the change.

## More Information

Design: `docs/designs/executive-assistant.md`. Amends ADR-0053 (the router is the Executive assistant job title; one session, not any number of tabs; notices link to the Org page), ADR-0064 (an eighth built-in job title that is never hired) and ADR-0069 (route `direct` creates no planning issue). Issue: #172.
