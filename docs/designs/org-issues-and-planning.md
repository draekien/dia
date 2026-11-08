# Org issues and planning

Closes draekien/dia#181. Renames the org's tasks to issues, using Linear's words, replaces the task states with ten issue statuses, adds a planning issue that every objective creates, and gives hired agents three tools (`create_issue`, `update_issue`, `comment_issue`). It also changes the `DiaTool` contract, so that the session's permission rules and mode decide whether a dia tool call asks.

Amends ADR-0064 (the `finished` state, and how a planning task starts) in a new ADR-0069, and records the vocabulary in `docs/glossary.md`.

## Scope

In scope:

- Rename `Task` to `Issue` across `plugins/org`. That covers code, tables, calls, UI copy and docs, including:
  - `scheduler.ts`: `StartCandidate.taskId` → `issueId`;
  - `service.ts` and `org.ts`: `HireHasOpenTasks` and `openTasksOf`;
  - `dispatcher.ts`: `LiveTask`, `startTask`, `resumeTask` and the `tasks` map;
  - `work.ts`: `WaitingTask` → `StartableIssue`;
  - `objectives-page.tsx`, `org-actions.ts` and `org-host.fake.tsx`, plus every JSDoc that says "task" for org work.
  
  The Claude Code `TaskCreate`/`TaskUpdate` tools in `session-tool-options.ts` are not org tasks and keep their names.
- The ten statuses, with `finished` removed.
- `description` on an issue.
- The planning issue.
- The three agent tools.
- The `DiaTool` permission contract.
- Triage UI: Accept and Decline, per issue and for all.
- Comments: stored, and listed on the objective screen.

Out of scope:

- answering a permission request (#182);
- editing or deleting objectives;
- user-written comments;
- the dashboard's Running now and Waiting lists;
- Linear priority names.

## Success criteria

1. Migration `7_issues` maps existing rows as follows:
   - `waiting` and `running` → `todo`;
   - `finished` and `completed` → `done`.
2. An objective created with no assignee has the issue "Plan: <title>" in `todo`, unassigned. With an assignee, the dispatcher starts that hired agent on the planning issue.
3. In a hired agent's session:
   - `mcp__dia__create_issue` adds a `triage` issue to the session's objective;
   - `mcp__dia__update_issue` sets a started issue to any started status;
   - `mcp__dia__comment_issue` adds a comment that the open objective screen shows.
4. A dia tool on the job title's allow list runs without a permission request. A dia tool on the deny list is refused.
5. Accept moves a `triage` issue to `todo`, and Decline moves it to `canceled`. Accept all and Decline all do the same for every `triage` issue of the objective that the screen shows.
6. Finish moves a started issue to `done`, and on a `work` issue it creates a `retro` sub-issue in `todo`. An objective is `completed` once every issue is `done` or `canceled`.
7. End to end: you create an objective with no assignee and assign its planning issue to an agent whose session may call the org tools (see *Decided: tool permissions for criterion 7*). The agent calls `create_issue`, the issues appear in Triage, and Accept all moves them to `todo`.

## Vocabulary

| Term | Meaning | Linear term |
| --- | --- | --- |
| Objective | A goal in one registered project, worked through as issues | (none; Linear's Project would clash with dia's project) |
| Issue | A unit of work in one objective | Issue |
| Sub-issue | An issue whose `parentIssueId` names another issue of the same objective | Sub-issue |
| Planning issue | The `planning` issue every objective creates. Its agent breaks the objective into `triage` issues | (none) |
| Retro issue | The `retro` sub-issue that finishing a `work` issue creates (ADR-0035) | (none) |
| Assignee | The one hired agent that runs an issue, or none | Assignee (Linear assigns people and delegates agents; dia assigns only agents) |
| Triage | The status of an issue an agent proposed. The user accepts it (→ `todo`) or declines it (→ `canceled`) | Triage |
| Comment | Text a hired agent attaches to an issue | Comment |

## Domain — `plugins/org/domain.ts`

```ts
export const IssueId = Uuid.pipe(Schema.brand('IssueId'))                 // replaces TaskId
export const IssueKind = Schema.Literals(['work', 'retro', 'planning'])

/** The statuses a hired agent moves its own issue through, in implement-task order; any order is allowed. */
export const StartedStatus = Schema.Literals([
  'understanding', 'designing', 'implementing', 'testing', 'verifying', 'in_review'
])
export const IssueStatus = Schema.Literals([
  'triage', 'todo', ...StartedStatus.literals, 'done', 'canceled'
])
export const isStarted = (status: IssueStatus): status is StartedStatus => Schema.is(StartedStatus)(status)
export const isClosed = (status: IssueStatus) => status === 'done' || status === 'canceled'

export const ISSUE_DESCRIPTION_MAX_LENGTH = 10_000
export const IssueDescription = Schema.String.pipe(Schema.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_LENGTH)))

export const Issue = Schema.Struct({
  id: IssueId, objectiveId: ObjectiveId, parentIssueId: Schema.NullOr(IssueId),
  kind: IssueKind, title: WorkTitle, description: IssueDescription, status: IssueStatus,
  assignee: Schema.NullOr(HireId), paneId: Uuid, sessionId: Schema.NullOr(SessionId), createdAt: Schema.Number
})

export const NewIssue = Schema.Struct({            // the user creates: lands in todo
  id: IssueId, objectiveId: ObjectiveId, parentIssueId: Schema.NullOr(IssueId),
  title: WorkTitle, description: IssueDescription, assignee: Schema.NullOr(HireId)
})
export const ProposedIssue = Schema.Struct({       // an agent proposes: lands in triage, unassigned
  parentIssueId: Schema.NullOr(IssueId), title: WorkTitle, description: IssueDescription
})
export const IssueChange = Schema.Struct({         // what update_issue may change
  title: Schema.optionalKey(WorkTitle), description: Schema.optionalKey(IssueDescription),
  status: Schema.optionalKey(StartedStatus)
})
export const TriageDecision = Schema.Literals(['accept', 'decline'])

export const CommentId = Uuid.pipe(Schema.brand('CommentId'))
export const CommentBody = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(10_000)))
export const IssueComment = Schema.Struct({
  id: CommentId, issueId: IssueId, author: Schema.NullOr(HireId), body: CommentBody, createdAt: Schema.Number
})                                                  // author null: the hired agent was dismissed

export const WorkSnapshot = Schema.Struct({
  objectives: Schema.Array(Objective), issues: Schema.Array(Issue), comments: Schema.Array(IssueComment)
})
```

Each export gets a derived `export type X = typeof X.Type`, and a JSDoc that states its meaning and when to use it.

`ObjectiveState` keeps the values `open` and `completed`. Its meaning changes to: `completed` when the objective has issues and every one is `done` or `canceled`.

Errors (`Schema.TaggedError`):

| Error | Fields | Raised by |
| --- | --- | --- |
| `IssueNotFound` | `issueId` | Any issue change, when the issue is missing or is in another objective than the one the call names |
| `IssueNotAssignable` | `issueId`, `status` | `assignIssue` on an issue that is not `triage` or `todo` |
| `IssueNotStarted` | `issueId`, `status` | `finishIssue`, and `updateIssue` with a `status`, on an issue that is not started |
| `IssueNotInTriage` | `issueId`, `status` | `triageIssues` on an issue that is neither `triage` nor already the decision's target |
| `IssueClosed` | `issueId`, `status` | `updateIssue` with a title or description, on a `done` or `canceled` issue |
| `HireHasOpenIssues` | `hireId`, `issues` | `dismiss` (renamed from `HireHasOpenTasks`). It counts issues that are neither `done` nor `canceled`. An `in_review` issue counts, so you cannot dismiss a hired agent until you finish it |

`ObjectiveNotFound`, `ProjectNotFound`, `HireNotFound` and `PermissionNotPending` are unchanged. `PendingPermission` and `AnswerPermission` rename `taskId` to `issueId`.

## Work — `plugins/org/work.ts`

```ts
export interface Work {
  readonly snapshot: Effect.Effect<WorkSnapshot>
  readonly watchChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  readonly createObjective: (input: NewObjective) => Effect.Effect<Objective, ProjectNotFound | HireNotFound>
  readonly createIssue: (input: NewIssue) => Effect.Effect<Issue, ObjectiveNotFound | IssueNotFound | HireNotFound>
  readonly proposeIssue: (objectiveId: ObjectiveId, input: ProposedIssue) => Effect.Effect<Issue, ObjectiveNotFound | IssueNotFound>
  readonly assignIssue: (issueId: IssueId, hireId: HireId | null) => Effect.Effect<Issue, IssueNotFound | IssueNotAssignable | HireNotFound>
  readonly triageIssues: (issueIds: NonEmptyReadonlyArray<IssueId>, decision: TriageDecision) => Effect.Effect<ReadonlyArray<Issue>, IssueNotFound | IssueNotInTriage>
  readonly updateIssue: (objectiveId: ObjectiveId, issueId: IssueId, change: IssueChange) => Effect.Effect<Issue, IssueNotFound | IssueNotStarted | IssueClosed>
  readonly commentIssue: (objectiveId: ObjectiveId, issueId: IssueId, author: HireId, body: CommentBody) => Effect.Effect<IssueComment, IssueNotFound>
  readonly finishIssue: (issueId: IssueId) => Effect.Effect<Issue, IssueNotFound | IssueNotStarted>
}
```

Each change runs as one transaction that writes its events and the rows it changes, and then publishes one change. Each method logs with `Effect.logInfo` (`Created issue`, `Proposed issue`, `Triaged issues`, `Updated issue`, `Commented on issue`, `Finished issue`), as `work.ts` does today. `updateIssue` and `commentIssue` fail with `IssueNotFound` when the issue's objective is not `objectiveId`. That check confines an agent's tools to its own objective.

`OrgEvent` becomes:
- `ObjectiveCreated`, `ObjectiveReopened`, `ObjectiveCompleted`;
- `IssueCreated {issue}`, `IssueAssigned {assignee}`, `IssueStarted {assignee}`, `IssueSessionStarted {sessionId}`, `IssueRequeued {sessionId}`;
- `IssueUpdated {change}`, `IssueTriaged {decision}`, `IssueCommented {commentId}`, `IssueFinished {}`.

The old `TaskFinished` and `TaskCompleted` tags leave the union. Nothing decodes `org_events`, so the old rows stay valid.

The SQL condition for "started" is built from `StartedStatus.literals` (`sql.in('status', StartedStatus.literals)`), not typed out by hand.

| Method | Behaviour |
| --- | --- |
| `createObjective` | Creates the open objective and its `planning` issue in one transaction. The planning issue has the title `Plan: <title>` (truncated to 120 characters, like `retroTitle`), an empty description, status `todo` and `assignee` set to the objective's assignee. A repeated `id` returns the stored objective and creates nothing. The planning issue's id and pane id are generated before the transaction, as `createTask` does (`work.ts:304`), and go unused on a repeated `id` |
| `createIssue` | Creates a `work` issue in `todo`. A repeated `id` returns the stored issue. It reopens a completed objective |
| `proposeIssue` | Creates an unassigned `work` issue in `triage` with a generated id. Only a live session calls it, so its objective is open, and it does not reopen one |
| `assignIssue` | Sets or clears the assignee of a `triage` or `todo` issue. Giving an issue its current assignee returns it unchanged, in any status |
| `triageIssues` | Accept moves each `triage` issue to `todo`. Decline moves each to `canceled`. An issue already in the target status is left unchanged. Any other status fails the whole call and changes nothing. For example, Accept all fails if another window has declined one of the issues; the screen shows "This issue is no longer in Triage" and refreshes from `WatchWork`. After a decline it checks whether the objective is now complete |
| `updateIssue` | Applies the present fields. `status` needs the issue to be started. `title` and `description` need it to be not closed. A change with `status` checks `IssueNotStarted` first, then `IssueClosed`. Any failure writes nothing. An empty change returns the issue unchanged |
| `commentIssue` | Stores a comment on the issue, in any status |
| `finishIssue` | Moves a started issue to `done`. On a `work` issue it also creates an unassigned `retro` sub-issue in `todo`. A `planning` or `retro` issue gets no retro. It then checks whether the objective is now complete. On an issue that is already `done` it returns the issue unchanged |

`IssueRuns` replaces `TaskRuns`. The dispatcher's own changes become:

| Method | Changes |
| --- | --- |
| `startCandidates` | Returns `todo` issues that have an assignee. `busyHires` are hired agents with a started issue |
| `markStarted` | Moves a `todo` issue assigned to `hireId` to `understanding` |
| `markSessionStarted` | Stores the session of a started issue |
| `markRequeued` | Moves a started issue other than `in_review` to `todo` |
| `requeueRunning` | Moves every started issue other than `in_review` to `todo` |

A requeued issue restarts in `understanding`, and its agent sets the later status again. Requeueing happens only when a session fails, or when the plugin starts while issues are started (ADR-0067).

An `in_review` issue is never requeued. Its session stays live and idle until you finish the issue, and `release` then closes it (`dispatcher.ts:459-470`). After a plugin restart, or a failed session, the issue stays `in_review` with its stored session id and no live session, and you finish it. A restart therefore does not wake the agent, and the issue stays marked ready for review. It still counts in `busyHires`. Its assignee therefore starts no other issue until you finish it, as a `running` task blocks its assignee today. If the agent keeps working after `in_review` and its session then fails, the issue stays `in_review` with no live session, and you finish it. Reopening an issue is out of scope. ADR-0069 records this as a consequence.

`openIssuesOf(hireId)` replaces `openTasksOf`. It counts the hired agent's issues that are neither `done` nor `canceled`.

## Migration — `7_issues` in `plugins/org/migrations.ts`

```sql
CREATE TABLE issues (
  issue_id        TEXT    PRIMARY KEY,
  objective_id    TEXT    NOT NULL REFERENCES objectives,
  parent_issue_id TEXT    REFERENCES issues(issue_id),
  kind            TEXT    NOT NULL CHECK (kind IN ('work', 'retro', 'planning')),
  title           TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL CHECK (status IN ('triage','todo','understanding','designing','implementing','testing','verifying','in_review','done','canceled')),
  assignee        TEXT    REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
  pane_id         TEXT    NOT NULL UNIQUE,
  session_id      TEXT,
  created_at      INTEGER NOT NULL
);
INSERT INTO issues (issue_id, objective_id, parent_issue_id, kind, title, status, assignee, pane_id, session_id, created_at)
  SELECT task_id, objective_id, parent_task_id, kind, title,
         CASE state WHEN 'waiting' THEN 'todo' WHEN 'running' THEN 'todo' ELSE 'done' END,
         assignee, pane_id, session_id, created_at
  FROM tasks ORDER BY rowid;
DROP TABLE tasks;
CREATE TABLE issue_comments (
  comment_id TEXT    PRIMARY KEY,
  issue_id   TEXT    NOT NULL REFERENCES issues,
  author     TEXT    REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
ALTER TABLE org_events RENAME COLUMN task_id TO issue_id;
```

Inserting `ORDER BY rowid` inserts each parent before its children, because a sub-issue or retro is always created after its parent. Existing `org_events` rows keep their `Task*` event tags. Nothing reads `org_events` back. New rows use `Issue*` tags. Existing objectives get no planning issue.

## Agent tools — `plugins/org/issue-tools.ts`

```ts
/** Where a hired agent's session works: its issue, that issue's objective, and the hired agent. */
export interface IssueToolScope {
  readonly issueId: IssueId
  readonly objectiveId: ObjectiveId
  readonly hireId: HireId
}

/**
 * The dia tools a hired agent's session gets: create_issue, update_issue and comment_issue,
 * each acting only within `scope.objectiveId`, with comments authored by `scope.hireId`.
 */
export const makeIssueTools = (
  work: Pick<Work, 'proposeIssue' | 'updateIssue' | 'commentIssue'>,
  scope: IssueToolScope
): ReadonlyArray<DiaTool>
```

| Tool | Input (strings) | Calls | Result text |
| --- | --- | --- | --- |
| `create_issue` | `title`, `description` (optional), `parent_issue_id` (optional, a uuid) | `work.proposeIssue(scope.objectiveId, …)` | `Created issue <id> "<title>" in Triage.` |
| `update_issue` | `issue_id` (optional, defaults to `scope.issueId`), `title` (optional), `description` (optional), `status` (optional, one of the six started statuses) | `work.updateIssue(scope.objectiveId, …)` | `Updated issue <id>: status in_review.` |
| `comment_issue` | `issue_id` (optional, defaults to `scope.issueId`), `body` | `work.commentIssue(scope.objectiveId, …, scope.hireId, body)` | `Commented on issue <id>.` |

Input handling:
- An `issue_id` or `parent_issue_id` outside the objective returns `IssueNotFound`.
- A typed failure is returned to the agent with `isError: true`, and its text names the cause (`Issue <id> is in done; only a started issue's status can change.`).
- `run` catches defects with `Effect.catchCause`, logs the cause and returns `Could not <action>.` with `isError: true`.
- `title` and `body` are trimmed before they are decoded as `WorkTitle` and `CommentBody`. A value that fails, or a `body` that is empty after trimming, returns `isError` with the reason, and nothing is written.
- The required fields `title` and `body` use the pattern `/[\s\S]/`. The optional fields use `/^[\s\S]*$/`, and `run` treats `''` as omitted for each of them. `create_issue` stores an omitted `description` as `''`.
- `run` checks the uuid of `issue_id` and `parent_issue_id`, and the value of `status`, not the field pattern. A `status` outside the six started statuses returns `isError` that lists the allowed values.
- `update_issue` may change `status` only on `scope.issueId`, the session's own issue. A `status` for any other issue returns `isError` (`Only your own issue's status can change.`). An agent can therefore not set another agent's issue to `in_review`. Title, description and comments may target any issue of the objective.

## `DiaTool` contract — `src/host/session/dia-tools.ts`, `plugins/claude-code`

Before, every call to a dia tool asked the user, in every permission mode. After, a dia tool goes through the same SDK permission evaluation as any other tool.

| Step (SDK order, [permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md)) | Effect on `mcp__dia__create_issue` |
| --- | --- |
| Deny rules | `disallowedTools: ['mcp__dia__create_issue']` refuses it |
| Ask rules | `settings.permissions.ask` sends it to `canUseTool`, even in `bypassPermissions` |
| Permission mode | `bypassPermissions` runs it. `default`, `acceptEdits` and `plan` do not approve MCP tools. `auto` has the classifier allow or block the call, with no request. `dontAsk` denies a call that no allow rule matches |
| Allow rules | `allowedTools: ['mcp__dia__create_issue']` or `['mcp__dia__*']` runs it |
| `canUseTool` | A permission request, the same one any tool raises |

The changes:

- **`dia-tools.ts`:**
  - The `DiaTool` doc becomes: "The backend applies the session's permission rules and mode to each call as it does to its own tools, and calls `run` only for an allowed call. `run` receives every field that lacks `optional: true`, and each field present matches its pattern."
  - `DiaToolField` gains `optional?: boolean`. Its JSDoc becomes "One input field of a {@link DiaTool}: a string the agent supplies, required unless `optional` is true, which must match `pattern`."
  - `run` receives `Readonly<Partial<Record<string, string>>>`. The plugin tools keep their `?? ''` reads.
  - The plugin tools' descriptions, and the `makePluginTools` JSDoc, drop "Asks the user to approve."
- **`tool-server.ts`:**
  - `DiaToolServerOptions` loses `approve`.
  - `makeDiaSdkTools` logs `Dia tool call` with the tool and input before `run`, and `Dia tool call returned` with `isError` after it. It maps an optional field to `z.string().regex(…).optional()`.
  - `isDiaToolName`, the `declined` result and their JSDoc are deleted.
- **`session.ts`:**
  - `makeCanUseTool` drops its `tools` parameter and the dia-tool branch.
  - `makeApproveDiaTool` and its tests are deleted.
  - The `canUseTool` test "allows a dia tool without asking" becomes "raises a permission request for a dia tool".
- Stale docs updated:
  - `AgentSessionOptions.diaTools` (`agent-backend.ts:161`, "each asked about before it runs");
  - `SessionFactoryLive` (`pane-supervisor.ts:192`, "after the user approves").
- `PLUGIN_API_VERSION` (`src/shared/plugin/manifest.ts`) goes from `0.0.32` to `0.0.33`, and the `api` field of every `plugins/*/plugin.json` (14 files) is set to `0.0.33`.
  - Why: an adapter plugin that implements `AgentBackend` must stop asking for approval itself, so the plugin contract changes.
  - `PROTOCOL_VERSION` is unchanged, because the org calls are plugin calls carried inside `CallPlugin` and `SubscribePlugin`, not new `DiaRpcs`.

What an ad-hoc pane sees for `plugin_reload`:

| Mode | Before | After |
| --- | --- | --- |
| `default`, no rule | A permission request | A permission request (from `canUseTool`) |
| `bypassPermissions` | A permission request | Runs |
| `auto` | A permission request | The classifier allows or blocks it; no request |

ADR-0069 records the consequence: outside `bypassPermissions`, the plugin tools lose the request they raised in every mode, unless the pane's rules or mode require one.

## Dispatcher — `plugins/org/dispatcher.ts`

- It takes `issueTools: (scope: IssueToolScope) => ReadonlyArray<DiaTool>`, which `host.ts` builds as `(scope) => makeIssueTools(work, scope)`.
- `openSession` passes `diaTools: issueTools({ issueId: issue.id, objectiveId: issue.objectiveId, hireId: hire.id })`.
- `promptFor(issue, objective)`, for a new session:

```
work / retro:
<title>

<description, omitted when empty>

Issue: <issue id>
Objective: <objective title>

<objective description>

planning:
Plan the objective "<objective title>".

<objective description>

Break it into issues with create_issue: one per piece of work another agent can finish on its own,
each with a description it can act on. They go to Triage for the user to accept.
When the plan is complete, set this issue to in_review with update_issue.
```

A resumed session still gets `RESUME_TEXT`.

## Calls — `plugins/org/calls.ts`

| Call | Payload | Success | Errors |
| --- | --- | --- | --- |
| `CreateObjective` | `{ objective: NewObjective }` | `Objective` | `ProjectNotFound`, `HireNotFound` |
| `CreateIssue` | `{ issue: NewIssue }` | `Issue` | `ObjectiveNotFound`, `IssueNotFound`, `HireNotFound` |
| `AssignIssue` | `{ issueId, hireId \| null }` | `Issue` | `IssueNotFound`, `IssueNotAssignable`, `HireNotFound` |
| `TriageIssues` | `{ issueIds: NonEmptyArray(IssueId), decision: TriageDecision }` | `Array(Issue)` | `IssueNotFound`, `IssueNotInTriage` |
| `FinishIssue` | `{ issueId }` | `Issue` | `IssueNotFound`, `IssueNotStarted` |
| `AnswerPermission` | `{ issueId, requestId, response }` | void | `PermissionNotPending` |

`WorkView` carries `comments` through `WorkSnapshot.fields`, and the JSDoc of `WorkView` and `WatchWork` says "objectives, issues and comments".

`host.ts` dispatcher calls:
- signals the dispatcher after `CreateObjective`, `CreateIssue` and `TriageIssues`;
- calls `dispatcher.release(issueId)` after `AssignIssue` when the issue is `todo`, as `AssignTask` does today for a `waiting` task (`host.ts:161-168`);
- calls `dispatcher.release(issueId)` after `FinishIssue`.

`release` signals the dispatcher itself (`dispatcher.ts:472`).

## Renderer — `plugins/org`

- **`objective-screen.tsx`:**
  - Issue tree rows show:
    - the title;
    - the first line of the description, muted and truncated;
    - a `Planning` or `Retro` kind label;
    - the status label (`STATUS_LABELS`: Triage, Todo, Understanding, Designing, Implementing, Testing, Verifying, In Review, Done, Canceled);
    - the assignee select, enabled in `triage` and `todo`;
    - the actions: Accept and Decline on a `triage` issue, and Finish on a started issue.
  - `issueStatusVariants` (cva) replaces `taskStateVariants`. Started statuses show in full ink, and `canceled` is muted with a line through it.
  - Above the tree, when the objective has `triage` issues, a bar reads "3 issues in Triage" next to Accept all and Decline all. Those buttons send `TriageIssues` with the ids the screen shows.
  - The add-issue form (formerly Add task) sends `CreateIssue` with `description: ''`. A description field in the form is out of scope.
  - Comments are listed under their issue row: the author's name ("Dismissed agent" when `author` is null) and the body.
- **`objective-dialog.tsx`:** the assignee's none option reads "Unassigned". The description reads "Its planning issue goes to the assignee, or waits until you assign it."
- Failure text (`issueFailureText`, replacing `taskFailureText`):

  | Error | Text |
  | --- | --- |
  | `IssueNotFound` | "This issue was removed" |
  | `IssueNotAssignable` | "This issue has already started" |
  | `IssueNotStarted` | "This issue has not started" |
  | `IssueNotInTriage` | "This issue is no longer in Triage" |

  Toast titles:
  - "Could not accept <title>" and "Could not decline <title>";
  - "Could not accept the issues" and "Could not decline the issues";
  - "Could not finish <title>" and "Could not assign <title>".
- **`org-host.fake.tsx`:**
  - The fixtures gain a planning issue, `triage` issues, an `implementing` issue, an `in_review` issue, a `canceled` issue and comments.
  - Fake handlers: `CreateObjective` (it adds the planning issue), `CreateIssue`, `AssignIssue`, `TriageIssues` and `FinishIssue` (to `done`, plus a retro for `work`). They replace the `CreateTask`, `AssignTask` and `FinishTask` handlers that set `finished`.
- The screens are designed with `/impeccable` against the fixtures before they are wired.

## Docs

- `docs/glossary.md` (new): the vocabulary table above, linked from `CLAUDE.md`'s Reference docs list.
- ADR-0069 "Org work is issues with implement-task statuses, and dia tools follow permission rules". It amends:
  - ADR-0064 "A finished task waits until its retro task is assigned and done": that now reads that finishing a `work` issue moves it to `done` and creates its retro;
  - ADR-0064's planning bullet: an objective with an assignee starts its planning issue at once;
  - ADR-0053's route `plan`: it creates an objective, whose planning issue follows this spec;
  - ADR-0026 ("Each tool asks the user itself, so approval holds in every permission mode that lets the tool run", line 35) and ADR-0019 (line 50): plugin tools follow the session's permission rules and mode, and in `bypassPermissions` they run without a request.

  Each amended ADR's status line gains "amended by ADR-0069". Add ADR-0069 to the ADR index.
- `docs/prds/org.md`:
  - the Agent tools table;
  - "served from dia-tools.ts" changes to `plugins/org/issue-tools.ts`;
  - the planning and retro lines (33, 69, 74-75).
- `docs/plans/2026-10-28-org.md`: line 41.
- `DESIGN.md` and `.impeccable/surfaces/plugins-org-org-page-tsx.md`: issue words and the Triage bar.

## Tests

| Criterion | Test |
| --- | --- |
| 1 | `migrations.test.ts`: tasks in each of the four states map to their statuses. A `running` task keeps its `session_id` as a `todo` issue, so its next start resumes the session (`dispatcher.ts:114,278`). A task, its sub-task and its retro migrate with foreign keys on. A comment row inserts |
| 2 | `work.test.ts`: `createObjective` with and without an assignee creates its planning issue. `dispatcher.test.ts`: an assigned planning issue starts. `host.test.ts`: `AssignIssue` on a `todo` issue releases and signals |
| 3 | `issue-tools.test.ts`: each tool against a real `Work` over SQLite. An out-of-objective id returns an error. A defect returns `isError`. `update_issue` with no `issue_id` changes the session's own issue. A `status` for another issue returns `isError`. `''` counts as omitted. `title` and `body` are trimmed, and an empty `body` writes nothing. A `status` outside the six returns `isError` with the allowed values |
| 3a | `dispatcher.test.ts`: `requeueRunning` leaves an `in_review` issue unchanged and moves an `implementing` one to `todo` |
| 4 | `tool-server.test.ts`: `run` is called with no approval step. `session.test.ts`: `canUseTool` raises a request for `mcp__dia__plugin_reload`. `session-tool-options.test.ts`: allow and deny rules reach `allowedTools` and `disallowedTools` |
| 5 | `work.test.ts`: `triageIssues`, including that an issue already at the target is unchanged, and that one non-triage issue fails the call and writes nothing. `org-page.test.tsx`: the buttons |
| 6 | `work.test.ts`: `finishIssue`. Objective completion when the last open issue is finished, and when it is declined. `createIssue` reopens a completed objective. `updateIssue` precedence (`IssueNotStarted` before `IssueClosed`) |
| 7 | Verify in the app |

## Decided: tool permissions for criterion 7 (option B)

Every built-in job title seeds `allow: []` (`built-in-job-titles.ts`). Hired agents start in `auto` when the model supports it, `bypassPermissions` when opted in, and `default` otherwise (`start-permission-mode.ts`). `auto` and `bypassPermissions` raise no request. Only a session in `default` mode is affected: there, `create_issue` raises a permission request that nothing can answer until #182. The planning agent then waits.

| Option | What changes | Criterion 7 in the app |
| --- | --- | --- |
| A. No change | The user adds `mcp__dia__*` to a job title's allow list, or opts it into bypass | Works after that edit. The verify run does the edit on a copy of a job title |
| B. Seed the built-ins | Migration `7_issues` adds `mcp__dia__create_issue`, `mcp__dia__update_issue` and `mcp__dia__comment_issue` to the seven built-in job titles' `allow`. User copies are unchanged | Works with any built-in job title |
| C. The dispatcher always allows them | The dispatcher appends the three tools to `permissions.allow` for every org session | Works always, but a job title's ask rule is still evaluated first and a deny rule still refuses |

The user chose B. Migration `7_issues` appends the three tools to each built-in job title's `allow` (rows whose `built_in` kind is set). A new install runs `3_job_titles` and then `7_issues`, so it gets them too, and `built-in-job-titles.ts` is unchanged. In `auto` and `bypassPermissions` no request is raised either way.

## Refinement Record

### Round 1

| # | Finding | Tag | Decision |
| --- | --- | --- | --- |
| 1 | Criterion 7 waits on an unanswerable permission request with the built-in job titles | blocker | Escalated: it depends on the user's rule that dia tools follow normal permissions. Options are above |
| 2 | Objective scoping has no mechanism in `Work` | blocker | Applied: `updateIssue` and `commentIssue` take `objectiveId` |
| 3 | ADR-0026:35 and ADR-0019:50 contradicted without an amendment | blocker | Applied: both added to ADR-0069 |
| 4 | Requeue wakes idle `in_review` sessions and resets their status | major | Applied: `in_review` is never requeued |
| 5 | `AssignIssue` lost `dispatcher.release` (`host.ts:161-168`) | major | Applied |
| 6 | Mode table omits `auto`, `plan` and `dontAsk` | major | Applied. `auto` raises no request; the classifier allows or blocks |
| 7 | `tool-server.ts` dropped its tool-call logging | major | Applied, along with logging for the new `Work` methods |
| 8 | `run` input type loses the required-field guarantee | major | Applied as a doc guarantee. A split `optionalInput` type was rejected: more surface for 2 callers |
| 9 | `makeIssueTools` takes all of `Work` and a stale `Issue` | major | Applied: a `Pick` and an `IssueToolScope` |
| 11 | `Issue*` event tags not listed | major | Applied |
| 12 | Stale approval docs in `agent-backend.ts`, `pane-supervisor.ts` and tests | major | Applied |
| 13 | `PLUGIN_API_VERSION` bump omits the 14 `plugin.json` files | major | Applied. Verified 14 files declare `api` |
| 14 | `IssueAlreadyStarted` also fires for done and canceled | minor | Applied: renamed `IssueNotAssignable` |
| 15 | Rename list incomplete | minor | Applied |
| 16 | `docs/glossary.md` is new | minor | Applied |
| 17 | Missing derived types and JSDoc. `optional` should be `optionalKey` | minor | Applied |
| 18 | Started statuses typed out in SQL | minor | Applied |
| 19 | `WorkView` gains `comments` automatically | minor | Applied |
| 20 | Defects in tool `run`. Default `issue_id` | minor | Applied both |
| 21 | Agent titles with trailing spaces fail `WorkTitle` | minor | Applied: trimmed |
| 22 | Empty `description` fails the pattern | minor | Applied |
| 23 | ADR-0053 and PRD planning text stale | minor | Applied |
| 24 | Test gaps | minor | Applied |

### Round 2

| # | Finding | Tag | Decision |
| --- | --- | --- | --- |
| 1 | `comment_issue` body not trimmed but `CommentBody` is `Schema.Trimmed` | major | Applied |
| 2 | `''` handling for optional fields undefined | minor | Applied: `''` means omitted. uuid and status are checked in `run` |
| 3 | Planning issue ids not specified | minor | Applied |
| 4 | `proposeIssue` reopen clause unreachable | minor | Applied: removed |
| 5 | Failure texts for the new errors missing | minor | Applied |
| 6 | Fake host handlers and fixtures under-specified | minor | Applied |
| 7 | Accept all fails as a whole on a race | minor | Applied as a note. The behaviour is kept |
| 8 | An agent can set another agent's issue to `in_review` | minor | Applied: `status` only on the session's own issue |
| 9 | `in_review` issue with a failed session stays `in_review` | minor | Applied as a stated consequence |
| 10 | `HireHasOpenIssues` and `in_review` | minor | Applied |

### Round 3

| # | Finding | Tag | Decision |
| --- | --- | --- | --- |
| 1 | An `in_review` issue keeps a live idle session. It is not without a session (`agent-backend.ts:26-32,97-102`) | major | Applied |
| 2 | `updateIssue` error precedence undefined | minor | Applied |
| 3 | The add-issue form must send `description` | minor | Applied: `''` |
| 4 | Stray sentence in Calls | minor | Applied |
| 5 | Duplicate glossary bullets | minor | Applied |
| 6 | `DiaToolField` JSDoc and required-field patterns | minor | Applied |
| 7 | `plugin_reload` table omits `auto` | minor | Applied, with an ADR-0069 consequence |
| 8 | Test rows miss stated behaviour | minor | Applied |

The round budget (3, medium effort) is spent. Round 3's major finding is applied.
