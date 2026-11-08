---
status: "accepted, amended by ADR-0064, ADR-0069 and ADR-0071"
date: 2026-11-06
decision-makers: William Pei
---

# Take the user's requests in chat through a built-in `router` role that hands work to hired agents and never plans or does the work itself

## Context and Problem Statement

ADR-0033 starts org work in two ways: the user fills in an objective form, and an objective left unassigned goes to the "objective watcher" role (default `planner`). The user wants to give work to dia the way a person gives work to an executive assistant: say what is wanted in a chat, and have the assistant decide who does it. DeepSeek's dsh-superagent prototype (<https://github.com/deepseek-ai/dsh-superagent-prototype>) separates a main session that only routes from executor sessions that do the work. Which agent takes the user's requests, what may it do, where does it live, and how does it relate to the objective watcher, the decision path (ADR-0034) and the caps (ADR-0033)?

## Decision Drivers

* The user states a request once, in their own words, and does not fill in a form or choose a project or role unless the request leaves it unclear.
* The agent that takes requests must answer while every cap is full.
* A worker or planner must receive what the user said, not the routing agent's reading of it. dsh-superagent's `prompts/dispatch.md`: "Do not paraphrase a short request into a work plan … workers derive requirements from the original source."
* A one-step request must not wait for a plan review; a multi-step objective still gets one (ADR-0034).
* Everything that waits on the user stays in one decision queue (ADR-0034).

## Considered Options

* Relation to the objective watcher: the router replaces it; the router only creates unassigned objectives and the watcher still assigns them; the router is the default watcher role and also plans
* Breakdown: the router sends every request to `planner`; the router sends every request to one worker (dsh-superagent); the router chooses between one worker and `planner`
* Return path: the decision queue only; the decision queue, with the router posting a notice in its chat; the router chat only, with the decision queue removed
* Session: one persistent router session; any number of router sessions the user opens and clears
* Location: inside a project, routing to any project; inside a project, routing only to that project; an org-level group outside projects
* Caps: the router is hired and counted; the router is not hired and not counted
* Handoff text: the user's words plus a routing note; a brief the router writes

## Decision Outcome

Chosen options: "the router replaces it", "the router chooses between one worker and `planner`", "the decision queue, with the router posting a notice", "any number of router sessions", "an org-level group", "not hired and not counted", and "the user's words plus a routing note". Together they give the user one place to ask for work, keep the agent that routes from planning, and keep the decision queue as the place the user acts.

### The `router` role

`router` is a built-in role (ADR-0033 "Built-in roles"). The user can copy and edit its instructions like any built-in role.

| Property | Value |
| --- | --- |
| Hired | No. The user opens router sessions directly; there is no hire and no per-role cap |
| Caps | Never counted toward the overall cap and never queued |
| Sessions | Any number. Each is a tab the user opens, clears, compacts and closes like any tab |
| Location | The `Assistant` group in the rail, above the project groups. A router tab belongs to no project (amends ADR-0023) |
| Projects | Routes to any registered project. It takes the project from the conversation, and asks the user once when the conversation does not name one |
| Tools | Only the routing tools in the "Routing tools" table of this ADR. No `Bash`, `Read`, `Edit`, `Write`, `Agent` or MCP tools from other servers |
| Permission mode | `dontAsk` (ADR-0054): every tool outside its allow list is denied without a prompt |
| State | Kept in objectives and tasks, not in the session. Before it creates an objective, the router reads open objectives so that a cleared, compacted or second router session does not create a duplicate |

### Routing tools

Served from the Host's in-process MCP server (`src/host/session/dia-tools.ts`).

| Tool | Effect |
| --- | --- |
| `objectives_read` | Lists objectives and tasks across projects with their state, assignee and summary, and the decision queue items that block them |
| `objective_create` | Creates an objective with a project, a title, the user's words verbatim, a routing note of at most 30 words, a priority, and a route: `direct` with a worker role or hired agent, or `plan` |
| `objective_attach` | Sends the user's message to the agents working on an existing objective, as a `queue` message (`docs/designs/message-queue-and-steer.md`) |
| `objective_stop` | Stops an objective at the user's request |

The router uses `objective_attach` only when the user's message names that objective or refers to work just started and exactly one objective fits. A message on a similar subject is a new request.

### Routes

| Route | When the router picks it | What happens |
| --- | --- | --- |
| `direct` | The request is one piece of work for one role, for example "fix the typo in the README" or "find out why CI is slow" | The objective gets one task, assigned to the named worker role (`engineer`, `researcher`) or hired agent. No plan review. A decision the worker records with `record_decision` still pauses it for review (ADR-0034) |
| `plan` | The request needs several tasks or several roles, for example "ship the plugin marketplace" | The objective goes to `planner`, which breaks it into tasks; the plan goes through decision path review (ADR-0034) |

The router writes no plan, task list, acceptance criteria or examples. The routing note holds only routing facts, such as "the user wants this before the release" or "the user said low priority".

### Return path

The decision queue (ADR-0034) is where the user acts. When an objective a router session created has a queue item (a plan to review, a decision, an `ask` permission) or finishes, the Host posts a short notice in that router session with a link to the queue item or the result, for example "Ada needs a decision on the theme storage → open". The user can answer in the queue or by replying to the router, which passes the reply on with `objective_attach`. When that router session is closed, the item appears only in the decision queue.

### The objective form

The objective form stays. An objective the user creates there without an assignee goes to `planner` (route `plan`). The org settings no longer have an objective watcher role, and on first run dia hires one `retro` and no objective watcher (amends ADR-0033).

Amended by ADR-0064: every `planner` reference in this ADR is a planning task. Route `plan` and an objective created without an assignee create a planning task, which waits until the user assigns it a hired agent; dia hires nobody on first run.

Amended by ADR-0069: route `plan` creates an objective, whose planning issue follows ADR-0069.

Amended by ADR-0071: the router is the built-in `Executive assistant` job title, not a role. The org plugin runs one assistant session in the `Assistant` group, with Start over, instead of any number of router tabs. Route `direct` creates the objective and one `work` issue for the named hired agent, with no planning issue. A notice links to the objective on the Org page, not to a decision queue item, and its text is prefixed to the user's next message.

### Consequences

* Good, because the user asks for work in their own words in one place, across all projects.
* Good, because a full cap never stops the user from talking to the router.
* Good, because a one-step request starts without a plan review, and a multi-step objective still gets one.
* Good, because the worker or planner reads the user's own words, so the router's reading cannot drop or add requirements.
* Bad, because the router can pick `direct` for work that needed a plan; the worker then records decisions as it goes, and each pauses it for review.
* Bad, because a request that names no project can cost the user one question.
* Bad, because a tab outside every project is a new kind of tab (amends ADR-0023).

## Pros and Cons of the Options

### Relation to the objective watcher: the router only creates unassigned objectives

* Good, because ADR-0033's watcher stays as it is.
* Bad, because the router cannot send a one-step request straight to a worker, so every request waits for `planner` and a plan review.

### Relation to the objective watcher: the router is the default watcher role and also plans

* Good, because one agent takes the request and plans it.
* Bad, because the agent that talks to the user also writes plans, which dsh-superagent's router is forbidden to do, so the user's words are replaced by the router's plan.

### Breakdown: every request to `planner`

* Good, because every objective's plan is reviewed (ADR-0034 unchanged).
* Bad, because a one-line fix waits for the user to approve a one-decision plan.

### Breakdown: every request to one worker

* Good, because it is dsh-superagent's model, with no planner stage.
* Bad, because a multi-step objective gets no plan review before work starts, and the work cannot be split across agents.

### Return path: the decision queue only

* Good, because the router chat stays short.
* Bad, because the user who asked in the router chat learns nothing there about the work it started.

### Return path: the router chat only

* Good, because it is dsh-superagent's model: one conversation for everything.
* Bad, because items that wait on the user are spread across many router sessions, with no single list.

### Session: one persistent router session

* Good, because it is dsh-superagent's model (one main session per deployment).
* Bad, because the user cannot start a clean conversation, and one long history needs compaction.

### Location: inside a project

* Good, because the tab's project answers "which project?" without a question.
* Bad, because the user chooses a project before talking to an assistant that serves every project, and router tabs are spread across project groups.

### Caps: the router is hired and counted

* Good, because the overall cap limits every agent dia starts on its own.
* Bad, because the user waits for a free slot to ask for more work.

### Handoff text: a brief the router writes

* Good, because the worker gets a structured description.
* Bad, because the router's interpretation replaces the user's words, and a misread requirement reaches every task.

## More Information

* Amends ADR-0023 (a router tab belongs to no project), ADR-0033 (the objective watcher is removed; `router` is a built-in role that is not hired) and ADR-0034 (a `direct` objective skips plan review).
* Related: ADR-0054 (permission modes for hired agents and the router), `docs/prds/org.md`, `docs/plans/2026-10-28-org.md` step 2.
* Source: dsh-superagent `docs/001-domain.md`, `docs/003-execution.md`, `prompts/orchestrator.md`, `prompts/dispatch.md`, read 2026-11-06.
