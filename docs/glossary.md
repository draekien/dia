# Glossary

Scope: the `issues` plugin (`plugins/issues`) and the `org` plugin (`plugins/org` as of ADR-0072, archived to `archive/org` by ADR-0076). Terms follow Linear where Linear has the concept.

## Vocabulary

| Term | Meaning | Linear term |
| --- | --- | --- |
| Objective | In the `issues` plugin: a goal in one registered project, worked through as issues | (none; Linear's Project would clash with dia's project) |
| Issue | In the `issues` plugin: a unit of work in one objective | Issue |
| Sub-issue | In the `issues` plugin: an issue whose `parentIssueId` names another issue of the same objective | Sub-issue |
| Planning issue | In the `issues` plugin: the `planning` issue an objective created by route `plan` starts with. Its agent breaks the objective into `triage` issues | (none) |
| Agent definition | The setup a session runs with: name, job description, skills, permission rules, MCP server names, bypass opt-in, model and thinking level. The `agent-definitions` plugin lists them; a plugin contributes some and the user adds or edits others | (none) |
| Job title | An agent definition as the org shows it, with whether the org enables it for new hires. Each hired agent has one | (none) |
| Executive assistant | The built-in job title, never hired, that runs the org's one assistant session and routes the user's requests (ADR-0071) | (none) |
| Route | How the Executive assistant hands a request on: `direct` creates the objective and one `work` issue for a named hired agent; `plan` creates the objective and its unassigned planning issue | (none) |
| Retro issue | The `retro` sub-issue that finishing a `work` issue is to create (ADR-0035). Finishing creates none until #42 | (none) |
| Assignee | An assignee reference: an id an assignee provider lists, or none. The org lists its hired agents | Assignee (Linear assigns people and delegates agents; dia assigns only agents) |
| Triage | In the `issues` plugin: the status of an issue an agent proposed or the org refused to start. The user accepts it (to `todo`) or declines it (to `canceled`) | Triage |
| Comment | In the `issues` plugin: text an assignee attaches to an issue | Comment |
| Assignee provider | A plugin that registers with `issues.registerProvider` under a provider id, lists the assignees it runs, and runs the issues assigned to them. The org is the `org` provider | (none) |

## Issue statuses

`IssueStatus` in `plugins/issues/domain.ts`. The six started statuses follow the phases of the `implement-task` workflow, and an agent may set them in any order.

| Status | Linear category | Set by |
| --- | --- | --- |
| `triage` | Triage | A hired agent, through `create_issue`; the dispatcher, when it refuses a `todo` issue whose job title names MCP servers or skills that are missing |
| `todo` | Unstarted | The user (creating an issue, or Accept); the objective's creation (planning issue); the dispatcher (requeue of a failed started issue); `issues`, when the issue's assignee provider is released (every started status except `in_review`) |
| `understanding` | Started | The dispatcher when it starts the issue's session; the agent through `update_issue` |
| `designing` | Started | The agent, through `update_issue` |
| `implementing` | Started | The agent, through `update_issue` |
| `testing` | Started | The agent, through `update_issue` |
| `verifying` | Started | The agent, through `update_issue` |
| `in_review` | Started | The agent, through `update_issue`, on its own issue only. The dispatcher never requeues it |
| `done` | Completed | The user (Finish) |
| `canceled` | Canceled | The user (Decline) |
