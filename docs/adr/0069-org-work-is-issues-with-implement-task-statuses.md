---
status: "accepted, amended by ADR-0071 and ADR-0072"
date: 2026-11-08
decision-makers: William Pei
---

# Make org work issues with implement-task statuses, and make dia tools follow the session's permission rules

## Context and Problem Statement

The org plugin calls its units of work tasks and gives a task four states (`waiting`, `running`, `finished`, `completed`). A hired agent has no tool to add work or report progress, and ADR-0064 makes the user assign every planning task before it starts. Separately, every call to a dia tool (`plugin_reload` and the other `plugin_*` tools) asks the user inside the tool, in every permission mode (ADR-0019, ADR-0026), so a job title's allow and deny lists and the session's mode cannot decide whether an org tool asks. What are the org's words and states for work, how does a hired agent add and report work, and who decides whether a dia tool call asks?

## Decision Drivers

* The user knows Linear, and wants the same words for the same things.
* The `implement-task` phases (understand, design, implement, test, verify, review) are the progress the user wants to see on an issue.
* A hired agent must be able to plan an objective into issues the user accepts or declines.
* A dia tool must obey the same allow, ask and deny rules and the same permission mode as any other tool.
* The built-in job titles must let an agent call the org tools without the user editing them first.

## Considered Options

* Keep tasks and four states; add the agent tools under the old names
* Rename tasks to issues, use ten statuses, add a planning issue and three agent tools, and make dia tools follow permission rules
* The same, with an extra tool allow-list option for tool permissions: A (no change), B (seed the built-in job titles' allow lists), C (the dispatcher always allows the org tools)

## Decision Outcome

Chosen option: "Rename tasks to issues, use ten statuses, add a planning issue and three agent tools, and make dia tools follow permission rules", with tool permissions option B, because it matches Linear's words, shows the `implement-task` phase on each issue, lets an agent plan, and leaves permission decisions to the rules the user already sets.

* **Vocabulary.** `docs/glossary.md` defines Objective, Issue, Sub-issue, Planning issue, Retro issue, Assignee, Triage and Comment, aligned with Linear.
* **Statuses.** An issue has one of ten statuses: `triage`, `todo`, `understanding`, `designing`, `implementing`, `testing`, `verifying`, `in_review`, `done`, `canceled`. The six started statuses map to the phases of `implement-task`. The old `finished` state is dropped: finishing a `work` issue moves it to `done` and creates its `retro` sub-issue in `todo`. An objective is `completed` when it has issues and every one is `done` or `canceled`.
* **Planning issue.** (Amended by ADR-0071: route `direct` creates one `work` issue for the named hired agent instead.) `CreateObjective` creates the objective and its `planning` issue "Plan: <title>" in `todo`, assigned to the objective's assignee. The dispatcher starts the planning issue at once when it has an assignee. With no assignee it waits until the user assigns it.
* **Agent tools.** A hired agent's session gets `create_issue` (adds a `triage` issue to the session's objective), `update_issue` (changes title, description, or the status of the session's own issue to a started status) and `comment_issue`. Each acts only within the session's objective.
* **Triage.** The user accepts a `triage` issue (to `todo`) or declines it (to `canceled`), one at a time or for every `triage` issue of the objective.
* **Dia tool permissions.** A dia tool call goes through the SDK's permission evaluation like any other tool call: deny rules, ask rules, permission mode, allow rules, then `canUseTool`. The `DiaTool` contract no longer asks the user. `PLUGIN_API_VERSION` goes from `0.0.32` to `0.0.33`.
* **Option B.** Migration `7_issues` appends `mcp__dia__create_issue`, `mcp__dia__update_issue` and `mcp__dia__comment_issue` to the `allow` list of each built-in job title. A user's copy of a job title is unchanged.

This amends:

* ADR-0064, "Planning and retro": a finished `work` issue moves to `done` and creates its retro, and it no longer waits for the retro to be assigned and done. An objective with an assignee starts its planning issue at once.
* ADR-0035, "require a retro before a task completes": a `work` issue moves to `done` when the user finishes it, and its retro is a separate issue. The objective still completes only when the retro is `done` or `canceled`.
* ADR-0053, route `plan`: it creates an objective, whose planning issue follows this ADR.
* ADR-0026 ("Each tool asks the user itself, so approval holds in every permission mode that lets the tool run") and ADR-0019 (each dia tool call goes through the pane's `canUseTool`): the `plugin_*` tools follow the session's permission rules and mode. In `bypassPermissions` they run without a request.

### Consequences

* Good, because the org's words match Linear's, and the user reads an issue's phase from its status.
* Good, because a hired agent can plan an objective and report progress, and the user accepts or declines what it proposes.
* Good, because a job title's allow, ask and deny lists decide whether a dia tool asks.
* Bad, because outside `bypassPermissions` the `plugin_*` tools no longer raise the unconditional request they raised in every mode. In `auto` the classifier allows or blocks the call with no request. A pane's ask rule or `default` mode still produces a request.
* Bad, because in `default` mode with no matching allow rule, a dia tool call raises a permission request that nothing can answer until #182. The agent waits. A built-in job title avoids this for the three issue tools through option B.
* Bad, because an `in_review` issue is never requeued. Its session stays live and idle until the user finishes the issue. After a plugin restart, or after its session fails, the issue stays `in_review` with no live session, and the user finishes it. A restart does not wake the agent. Reopening an issue is not built.
* Bad, because an `in_review` issue still counts as open for its assignee. The assignee starts no other issue, and `dismiss` fails with `HireHasOpenIssues`, until the user finishes the issue.
* Bad, because a plugin adapter that implements `AgentBackend` must stop asking for approval itself, which is a plugin API change (`PLUGIN_API_VERSION` `0.0.33`).

## Pros and Cons of the Options

### Keep tasks and four states; add the agent tools under the old names

* Good, because no migration or rename is needed.
* Bad, because the words differ from Linear's and a state does not show the phase of the work.
* Bad, because a dia tool keeps asking in every mode.

### Rename tasks to issues, use ten statuses, add a planning issue and three agent tools, and make dia tools follow permission rules

* Good, because it meets every decision driver.
* Bad, because it renames the org's tables, calls and events, and needs a migration.

### Tool permissions: A, no change

* Good, because no migration touches job titles.
* Bad, because the user edits a job title's allow list before the planning agent can call `create_issue`.

### Tool permissions: B, seed the built-in job titles' allow lists

* Good, because every built-in job title can call the three issue tools. A new install gets them from `7_issues`, which runs after `3_job_titles`.
* Bad, because a user's copy of a built-in job title keeps its old allow list.

### Tool permissions: C, the dispatcher always allows the org tools

* Good, because the tools work for every org session.
* Bad, because the dispatcher overrides the job title's allow list, so a user cannot withhold the tools by editing it.

## More Information

* Design: `docs/designs/org-issues-and-planning.md`.
* Vocabulary and statuses: `docs/glossary.md`.
* Implementation: `plugins/org/issue-tools.ts`, `plugins/org/domain.ts`, `plugins/org/migrations.ts` (`7_issues`), `src/host/session/dia-tools.ts`.
