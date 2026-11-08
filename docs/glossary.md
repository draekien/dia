# Glossary

Scope: the org plugin (`plugins/org`) as of ADR-0071. Terms follow Linear where Linear has the concept.

## Vocabulary

| Term | Meaning | Linear term |
| --- | --- | --- |
| Objective | A goal in one registered project, worked through as issues | (none; Linear's Project would clash with dia's project) |
| Issue | A unit of work in one objective | Issue |
| Sub-issue | An issue whose `parentIssueId` names another issue of the same objective | Sub-issue |
| Planning issue | The `planning` issue an objective creates, except one created by route `direct`. Its agent breaks the objective into `triage` issues | (none) |
| Executive assistant | The built-in job title, never hired, that runs the org's one assistant session and routes the user's requests (ADR-0071) | (none) |
| Route | How the Executive assistant hands a request on: `direct` creates the objective and one `work` issue for a named hired agent; `plan` creates the objective and its unassigned planning issue | (none) |
| Retro issue | The `retro` sub-issue that finishing a `work` issue creates (ADR-0035) | (none) |
| Assignee | The one hired agent that runs an issue, or none | Assignee (Linear assigns people and delegates agents; dia assigns only agents) |
| Triage | The status of an issue an agent proposed. The user accepts it (to `todo`) or declines it (to `canceled`) | Triage |
| Comment | Text a hired agent attaches to an issue | Comment |

## Issue statuses

`IssueStatus` in `plugins/org/domain.ts`. The six started statuses follow the phases of the `implement-task` workflow, and an agent may set them in any order.

| Status | Linear category | Set by |
| --- | --- | --- |
| `triage` | Triage | A hired agent, through `create_issue` |
| `todo` | Unstarted | The user (creating an issue, or Accept); the objective's creation (planning issue); the dispatcher (requeue of a failed started issue) |
| `understanding` | Started | The dispatcher when it starts the issue's session; the agent through `update_issue` |
| `designing` | Started | The agent, through `update_issue` |
| `implementing` | Started | The agent, through `update_issue` |
| `testing` | Started | The agent, through `update_issue` |
| `verifying` | Started | The agent, through `update_issue` |
| `in_review` | Started | The agent, through `update_issue`, on its own issue only. The dispatcher never requeues it |
| `done` | Completed | The user (Finish) |
| `canceled` | Canceled | The user (Decline) |
