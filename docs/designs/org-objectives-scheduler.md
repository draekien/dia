# Org objectives, tasks and scheduler

Status: accepted. Issue: #179 (part of #40, step 1 of `docs/plans/2026-10-28-org.md`, items 1 and 5). Implements ADR-0033 ("Scheduling"), ADR-0054 ("Mode at session start": the first caller of `startPermissionMode`) and the retro rule of ADR-0064. Decision recorded in ADR-0067 (hired agent sessions run headless in the org plugin).

The `org` plugin stores objectives and tasks, and runs each assigned task as a headless session of its hired agent, within the overall cap.

## Scope

In:

* Objective and task schemas in `plugins/org/domain.ts`.
* An event table and two projection tables in the org plugin's database, written in one transaction per change (ADR-0042, `docs/designs/host-database.md`).
* The scheduler and the slot rules of ADR-0033.
* Headless hired-agent sessions opened through `AgentBackend.openSession`, with the job title's model, thinking level, tools and job description, and the start mode `startPermissionMode` picks.
* A job title's `model` and `thinkingLevel`, and the job title editor's fields for them.
* `finishTask` and the retro task of ADR-0064.
* Plugin calls for every change and one read.
* `@dia/plugin` exports for the values the plugin needs, and the plugin API version bump.
* `docs/adr/0067-hired-agent-sessions-run-headless-in-the-org-plugin.md` and its row in `docs/adr/README.md`.
* JSDoc on every new export and `Effect.log*` calls in `work.ts` and `dispatcher.ts` (root `CLAUDE.md`, "Coding").

Out:

* The objective form and screen (#180), `create_task`/`update_task`/`finish_task` tools and planning tasks (#181), showing a hired agent's session (#182), the decision queue screen and `record_decision` (plan step 3), the Dashboard's "Running now".
* In this issue only the user finishes a task (the `FinishTask` call). A `running` task whose turn is idle keeps its hire busy until then.
* Answering a hired agent's `AskUserQuestion` or plan review, and messages from the user to a hired agent (`queue`/`steer`). The session waits with its slot free; #182 answers it from the session's tab.
* Resuming a parked turn (`TurnParked`). The task stays `running` and idle; #182 shows it as parked.

## Key Data Structures

All in `plugins/org/domain.ts`.

```ts
ObjectiveId = Uuid.pipe(Schema.brand('ObjectiveId'))
TaskId      = Uuid.pipe(Schema.brand('TaskId'))
WorkTitle   = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(120)), Schema.brand('WorkTitle'))

ObjectivePriority = Schema.Literals(['high', 'normal', 'low'])
ObjectiveState    = Schema.Literals(['open', 'completed'])
TaskKind          = Schema.Literals(['work', 'retro'])
TaskState         = Schema.Literals(['waiting', 'running', 'finished', 'completed'])

Objective = Schema.Struct({
  id: ObjectiveId,
  projectId: ProjectId,
  title: WorkTitle,
  description: Schema.String,
  priority: ObjectivePriority,
  assignee: Schema.NullOr(HireId),   // the hire #181 starts on the objective; #179 stores it only
  state: ObjectiveState,
  createdAt: Schema.Number           // epoch ms, from Clock
})

Task = Schema.Struct({
  id: TaskId,
  objectiveId: ObjectiveId,
  parentTaskId: Schema.NullOr(TaskId),  // for a retro task: the task it reviews
  kind: TaskKind,
  title: WorkTitle,
  state: TaskState,
  assignee: Schema.NullOr(HireId),
  paneId: Uuid,                          // fixed at creation; the id #182 shows the session under
  sessionId: Schema.NullOr(SessionId),   // the session to resume on the next start
  createdAt: Schema.Number
})

PendingPermission = Schema.Struct({
  taskId: TaskId,
  requestId: Schema.String,
  toolName: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown)
})
```

Task states:

| State | Meaning | Left by |
| --- | --- | --- |
| `waiting` | Not started, or its session ended. Starts when it has an assignee, the assignee has no `running` task, and a slot is free | the scheduler starting it (`running`) |
| `running` | Its hire has a session for it. It holds a slot only while a turn or background work runs (Slots) | `finishTask` (`finished`; a `retro` task goes to `completed`), its session ending (`waiting`) |
| `finished` | The work is done; its retro task is not completed | its retro task completing (`completed`) |
| `completed` | Done | never |

* `finishTask(t)` on a `work` task writes `TaskFinished`, and creates a `retro` task with `parentTaskId = t`, `assignee = null`, title `Retro: <t.title>` (cut to 120 characters), state `waiting`.
* `finishTask(r)` on a `retro` task writes `TaskCompleted` for `r` and for its parent.
* An objective is `completed` when it has at least one task and every task is `completed` (`ObjectiveCompleted`). `createTask` in a `completed` objective reopens it (`ObjectiveReopened`).

`JobTitle` gains `model: Schema.NullOr(Schema.NonEmptyString)` (null: the first model of the agent backend's `Ready` catalog) and `thinkingLevel: ThinkingLevel`. `JobTitleEdit` gains both as optional keys.

Errors, each a `Schema.TaggedError`:

| Error | When |
| --- | --- |
| `ObjectiveNotFound { objectiveId }` | `createTask` names a missing objective |
| `TaskNotFound { taskId }` | a missing task, or a `parentTaskId` that is missing or in another objective |
| `ProjectNotFound { projectId }` | `createObjective` names a project the workspace does not list |
| `TaskNotWaiting { taskId, state }` | `assignTask` gives a started task a different assignee |
| `TaskNotRunning { taskId }` | `finishTask` on a `waiting` task |
| `HireNotFound { hireId }` (exists) | `createObjective`, `createTask` or `assignTask` names a missing hire |
| `PermissionNotPending { taskId, requestId }` | `answerPermission` names no pending request |
| `HireHasOpenTasks { hireId, tasks: Schema.Int }` | `dismiss` of a hire assigned to a task that is not `completed`. A hire whose work task is `finished` stays assigned to it until its retro task completes, so it cannot be dismissed before then |

`NewObjective`, `NewTask`, `WorkSnapshot`, `LiveWork` and each `OrgEvent` member are `Schema.Struct`s (the events `Schema.TaggedStruct`s, each a named export so it has `.make`); their types are derived from them. `StartCandidate` and `StartContext` are internal and plain types.

## Interface

### Work (`work.ts`, `makeWork`)

Not provided as a service: `host.ts` serves the calls from it. #181 decides whether its tools need a service key.

```ts
interface Work {
  readonly snapshot: Effect.Effect<WorkSnapshot>   // objectives and tasks
  readonly createObjective: (input: NewObjective) => Effect.Effect<Objective, ProjectNotFound | HireNotFound>
  readonly createTask: (input: NewTask) => Effect.Effect<Task, ObjectiveNotFound | TaskNotFound | HireNotFound>
  readonly assignTask: (taskId: TaskId, hireId: HireId | null) => Effect.Effect<Task, TaskNotFound | TaskNotWaiting | HireNotFound>
  readonly finishTask: (taskId: TaskId) => Effect.Effect<Task, TaskNotFound | TaskNotRunning>
}

NewObjective = { id: ObjectiveId, projectId, title, description, priority, assignee: HireId | null }
NewTask      = { id: TaskId, objectiveId, parentTaskId: TaskId | null, title, assignee: HireId | null }
WorkSnapshot = { objectives: Objective[], tasks: Task[] }
LiveWork     = { pendingPermissions: PendingPermission[], heldSlots: number }   // from the dispatcher
```

`makeWork(projectExists: (projectId) => Effect<boolean>)` runs with the SQL client and returns `{ work, runs, openTasksOf }`. `projectExists` answers from the latest workspace, so `createObjective` fails with `ProjectNotFound` for an unlisted project. `makeWork` has no `Org` dependency: it checks that a hire exists with `SELECT 1 FROM hired_agents`, as `org.ts` checks its own rows. `runs: TaskRuns` is the dispatcher's write side: `startCandidates: Effect<{ waiting, busyHires }>`, read in one query pass (the waiting tasks with an assignee, and the hires with a `running` task), and the conditional writes `markStarted`, `markSessionStarted`, `markRequeued` and `requeueRunning`.

The dispatcher's members: `signal: Effect<void>`, `lendBackend(backend): Effect<void, never, Scope>` (the backend is used until the calling scope closes), `answerPermission(taskId, requestId, response): Effect<void, PermissionNotPending>`, `release(taskId): Effect<void>`, `live: Effect<LiveWork>`.

Every change is safe to repeat, because `ctx.serve` can run a handler twice for one call (`src/shared/plugin/api.ts:197`):

* The caller generates `id` in `NewObjective` and `NewTask`. Creating an id that exists returns the stored row.
* `assignTask` to the task's current assignee returns the task unchanged in any state.
* `finishTask` on a `finished` or `completed` task returns it unchanged.
* `answerPermission` for a request already answered returns. The dispatcher keeps the answered request ids of a task until the task leaves `running`; `PermissionNotPending` means the request id was never pending in the task's live session.

`createTask` always creates a `work` task. Only `finishTask` creates `retro` tasks.

`makeWork` also returns `openTasksOf: (hireId) => Effect<number>` (a database failure is a defect, as in `Org`). `makeOrg` takes it as a dependency, so `makeWork` is built first. `dismiss` calls it inside its transaction and fails with `HireHasOpenTasks` when it is above 0.

### Plugin calls (`calls.ts`)

`ReadWork` (success `{ ...WorkSnapshot, ...LiveWork }`: `host.ts` joins `work.snapshot` and `dispatcher.live`), `CreateObjective`, `CreateTask`, `AssignTask`, `FinishTask`, each with the payload and errors of the `Work` member of the same name, and `AnswerPermission`, served from `dispatcher.answerPermission`, which signals itself after queuing the answer. `Dismiss` gains the error `HireHasOpenTasks`.

`host.ts` calls `dispatcher.signal` after every successful `CreateTask` and `SetOverallCap` handler run, and `dispatcher.release(taskId)` after every successful `AssignTask` and `FinishTask` handler run. `Work` and `Org` do not know the dispatcher.

### Scheduler (`scheduler.ts`, pure)

```ts
export const nextStarts = (input: {
  readonly overallCap: OverallCap
  readonly heldSlots: number
  readonly busyHires: ReadonlySet<HireId>        // hires with a `running` task
  readonly answered: ReadonlyArray<TaskId>       // tasks with an answered permission, oldest answer first
  readonly waiting: ReadonlyArray<StartCandidate>
}): { readonly resume: ReadonlyArray<TaskId>; readonly start: ReadonlyArray<TaskId> }

StartCandidate = { taskId: TaskId, hireId: HireId, priority: ObjectivePriority, createdAt: number }
```

* `resume`: answered tasks, in order, while `heldSlots + resumed < overallCap + 1`.
* `start`: candidates whose hire is not in `busyHires`, by `priority` (`high`, `normal`, `low`), then `createdAt` ascending, then `taskId`, at most one per hire, while `heldSlots + resumed + started < overallCap`.

A hire runs one task at a time, so a job title never has more running agents than hires, which is its cap (ADR-0033). An answered task's hire is already running, so a resume adds no running agent to its job title either. ADR-0033 allows one over the job title's cap for an answer; this model never needs that allowance.

## Slots

The dispatcher keeps a `SlotState` per running task: `{ turn: 'running' | 'awaiting-user' | 'idle', background: number }`. A task holds a slot when `turn === 'running' || background > 0`.

| Event | Effect on `SlotState` |
| --- | --- |
| The dispatcher sends the task's first message | `turn = 'running'` |
| The dispatcher resumes a task: it resolves every answered request of the task | `turn = 'running'`, or `'awaiting-user'` when requests are still pending |
| `PermissionRequested`, `QuestionRequested`, `PlanReviewRequested` | `turn = 'awaiting-user'`. A `PermissionRequested` is added to the pending permissions |
| An activity event while `turn !== 'running'` and the task has no pending permission. Activity events are `AssistantMessageReceived`, `AssistantTextDelta`, `AssistantThinkingDelta`, `ToolCallStarted`, `ToolCallCompleted`, `ToolCallUpdated` and `UserMessagesSent` (`src/host/session/protocol.ts`) | `turn = 'running'` |
| `TurnCompleted`, `TurnErrored`, `TurnParked` | `turn = 'idle'` |
| `BackgroundTasksChanged { tasks }` | `background = tasks.length` |

Every other `OutboundMessage` (`TurnStatusChanged`, `SessionNotice`, `SessionStarted`, `PermissionModeChanged`, `ModelChanged`, `ContextUsageChanged`, `ConversationCompacted`, `ConversationReset`, `CompactionFailed`, the checkpoint, rewind, slash-command and `MessageQueueChanged` events) does not change `SlotState`; several arrive after `TurnCompleted`.

Per task the dispatcher holds `pending` (permission requests not yet answered), `queuedAnswers` (answers given through `answerPermission` and not yet resolved, with the time each was given) and `answeredIds` (every request id answered in the live session, for repeated calls). All three are in memory only and are dropped when the task finishes or is requeued. A permission is answered only through `AnswerPermission`.

The `answered` input of `nextStarts` lists each task with a `queuedAnswers` entry once, ordered by its oldest queued answer. A resume resolves every queued answer of the task and is charged one slot in that pass; when requests remain pending, `turn` stays `'awaiting-user'` and the slot is free again for the next pass.

The cap bounds what the dispatcher starts and resumes. A session can take a slot on its own (a question or plan review answered from #182's tab, a turn the SDK starts after background work, background work starting while idle), which can put `heldSlots` above the cap. The next pass then starts nothing until `heldSlots` is below the cap again.

## Dispatcher (`dispatcher.ts`)

Owns the live sessions: per running task, its `Scope`, its `AgentSession`, its `SlotState`, its pending and answered permission requests. It is the only module that opens sessions. It exposes `signal: Effect<void>`, `answerPermission`, and `live: Effect<LiveWork>`.

**Serialisation.** One worker fiber, forked in the plugin's scope, takes from a `Queue.sliding(1)` of signals and runs one pass per signal, so passes never overlap. The live map is a `SynchronizedRef`. A pass reads `heldSlots`, calls `nextStarts`, and sets `SlotState{ turn: 'running', background: 0 }` for every chosen task in one `SynchronizedRef.modify`, then starts or resumes them. Session `emit` handlers update the same `SynchronizedRef`, write `TaskSessionStarted` (a write failure is a defect, logged at error level), and offer a signal when a slot is freed. Signals come from `host.ts` (calls), slot releases, `Ready` catalog changes, the agent backend being provided, and workspace changes.

**Starting** a task: `runs.startCandidates` returns, per waiting task with an assignee, `{ task, objective }`, and `busyHires`; the dispatcher supplies `heldSlots` and `answered`. The dispatcher adds the hire and job title from `org.hiredAgents` and `org.jobTitles`, and the project from the latest workspace, into a `StartContext { task, objective, hire, jobTitle, project }`.

1. Model: `jobTitle.model`, or the first `ModelOption` of the latest `Ready` catalog. With no backend or no `Ready` catalog the pass skips starts.
2. Mode: `startPermissionMode({ modelSupportsAuto, disabled: yield* backend.disabledPermissionModes(project.directory), bypassOptedIn: hire.bypassOverride ?? jobTitle.bypassOptIn })`. `modelSupportsAuto` is the matching `ModelOption.autoMode`, false when the model is not listed. Log the inputs and the result at info level.
3. Write `TaskStarted` (state `running`) with `UPDATE tasks ... WHERE task_id = ? AND state = 'waiting' AND assignee = ?` (the hire chosen in the pass). If it changes no row (the task was reassigned or finished since the read), drop its `SlotState`, signal, and stop.
4. `Scope.make()`, then `openSession` in it with `config = { paneId: task.paneId, cwd: project.directory, model, thinkingLevel: jobTitle.thinkingLevel, permissionMode: mode }`, `systemPromptAppend = jobTitle.jobDescription`, `pluginPaths = []`, `diaTools = []`, `tools = Option.some({ permissions: jobTitle.permissions, mcpServers: jobTitle.mcpServers })`, `resume = Option.fromNullable(task.sessionId)`, and `emit` the slot handler.
5. `sendText(prompt, 'queue')`. The prompt for a new session is the task title, the objective title and the objective description. For a resumed session it is `RESUME_TEXT`.
6. `SessionStarted { sessionId }` writes `TaskSessionStarted` when `sessionId` differs from the stored one.
7. Fork a fiber into the task's scope that waits on `session.ended`. `ended` does not complete when the scope closes (`agent-backend.ts`, `ended`), so the fiber is interrupted with the scope.

**Session ended** while the task is `running`: `SessionNotFound` clears `sessionId`. `SessionFailed` adds the task to an in-memory `failed` set, which the pass removes from `waiting` until the next backend change, `Ready` catalog change, or `assignTask` on it. Both write `TaskRequeued` (state `waiting`), drop the `SlotState`, close the scope, and log at warning level.

**Conditional writes.** Every dispatcher write other than `TaskStarted` is `UPDATE tasks ... WHERE task_id = ? AND state = 'running'`. A write that changes no row writes no event and is logged at debug level. So a `TaskRequeued` or `TaskSessionStarted` that arrives after `finishTask` commits changes nothing.

**`release(taskId)`** runs after `finishTask` or `assignTask` commits: the dispatcher drops the task's `SlotState` and pending permissions, closes its scope, and signals.

**Plugin setup** requeues every `running` task (its sessions belong to the previous setup), keeping `sessionId`. The plugin scope's finalizer closes every task scope.

**Projects.** `host.ts` keeps the latest `Workspace` from `ctx.workspace` in a `Ref`, and waits for the first value before it serves any call. It passes `projectExists` to `makeWork` and the project directory lookup to `makeDispatcher`. A candidate whose project is not listed is skipped and logged at warning level.

The scheduler pass logs `heldSlots`, `answered.length`, `waiting.length`, and the `resume` and `start` it picked, at debug level.

## Storage

Migration `5_job_title_model`: `ALTER TABLE job_titles ADD COLUMN model TEXT` and `ALTER TABLE job_titles ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'medium'`. The default is a literal, not `DEFAULT_THINKING_LEVEL`, so the migration does not change when the constant does.

Migration `6_objectives_tasks`:

```sql
CREATE TABLE org_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  objective_id TEXT    NOT NULL,
  task_id      TEXT,
  event        TEXT    NOT NULL   -- JSON of OrgEvent
);
CREATE TABLE objectives (
  objective_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high','normal','low')),
  assignee TEXT REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('open','completed')), created_at INTEGER NOT NULL);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, objective_id TEXT NOT NULL REFERENCES objectives,
  parent_task_id TEXT REFERENCES tasks(task_id), kind TEXT NOT NULL CHECK (kind IN ('work','retro')),
  title TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('waiting','running','finished','completed')),
  assignee TEXT REFERENCES hired_agents(hire_id) ON DELETE SET NULL,
  pane_id TEXT NOT NULL UNIQUE, session_id TEXT, created_at INTEGER NOT NULL);
```

`OrgEvent` is a `Schema.Union` of tagged structs: `ObjectiveCreated`, `ObjectiveReopened`, `ObjectiveCompleted`, `TaskCreated`, `TaskAssigned`, `TaskStarted`, `TaskSessionStarted`, `TaskRequeued`, `TaskFinished`, `TaskCompleted`. Plan step 3 adds the decision path's events (ADR-0034) to the same union and table; each event names its objective, so an objective's decision path is a read of its events.

`work.ts` is the only writer of the three tables. Each change appends its events and updates the projection rows in one `sql.withTransaction`. `at` and `createdAt` come from `Clock.currentTimeMillis`.

## Plugin API

`src/host/plugin-api.ts` exports `startPermissionMode` and `HiredStartMode`, `ProjectId`, `ThinkingLevel` and `PermissionResponse`. `PLUGIN_API_VERSION` (`src/shared/plugin/manifest.ts:24`) goes from 0.0.30 to 0.0.31, and every `plugins/*/plugin.json` declares `"api": "0.0.31"`, because below 0.1.0 the loader accepts only an exact match. `JobTitle.mcpServers` (`McpServers`) must assign to `SessionToolOptions.mcpServers` (`Record<string, unknown>`); the type check confirms it.

## Tests

| Test file | Covers |
| --- | --- |
| `scheduler.test.ts` | `nextStarts`: the overall cap, one over for resumes, one start per hire, busy hires skipped, priority then age then id order |
| `dispatcher.test.ts` | a fake `AgentBackend` and `TestClock`: 60 tasks across 3 job titles with interleaved events; `heldSlots` started by the dispatcher never exceeds N and running agents of a job title never exceed its hires (criterion 1); the opened `AgentSessionOptions` (criterion 5); slot release and hold rules; an answer resumes ahead of waiting tasks at N+1; requeue on `SessionNotFound`/`SessionFailed`; a reassign before `TaskStarted` opens no session; an activity event after an answer from elsewhere re-takes the slot, and `TurnStatusChanged`/`ContextUsageChanged` after `TurnCompleted` do not; two pending requests with one answered stay `awaiting-user`; a repeated `answerPermission` succeeds |
| `work.test.ts` | each change writes its event and projection rows in one transaction (a forced failure leaves neither); the retro rules; objective completion and reopening; every change repeated returns the same result, including `finishTask` on a `retro` task |
| `host.test.ts` | a `CreateTask` call and a `SetOverallCap` call start a waiting task through the fake backend |
| `migrations.test.ts` | `5_job_title_model` gives existing rows `model` null and `thinking_level` `'medium'`; `6_objectives_tasks` creates the tables |
| `org.test.ts` | `dismiss` fails with `HireHasOpenTasks` |
| `job-title-editor` test | saving a model and a thinking level (criterion 8) |

## Internal Decomposition

* **`domain.ts`** — the schemas and errors above.
* **`work.ts`** — owns objectives and tasks: their rows, their events and the state rules (the retro task, completing the parent, completing and reopening the objective), and the read of waiting tasks with their objectives and the busy hires.
* **`scheduler.ts`** — owns the start order: `nextStarts`.
* **`dispatcher.ts`** — owns live sessions and slots: starting, resuming, answering, requeuing.
* **`org.ts`** — `dismiss` refuses `HireHasOpenTasks`; the job title's two new fields.
* **`host.ts`** — holds the workspace and the backend, builds `makeWork`, then `makeOrg` with `openTasksOf`, then the dispatcher; serves the calls and signals the dispatcher after each change.
* **`job-title-editor.tsx`** — a model select (`Default` for null, then the catalog's models) and a thinking level select.

## Design Rationale

**Headless sessions in the plugin.** A plugin cannot open a tab (`PaneWorkspace` is Host-internal), and the user chose not to change the plugin API for that in #179. `AgentBackend.openSession` gives the dispatcher every event through its own `emit`, so the slot rules need no Host change. #182 decides how these sessions are shown. Recorded in ADR-0067.

**The job title cap holds by construction.** One task per hire makes "at most M of a job title" true without a check, so the scheduler checks one number.

**Answers resume through the scheduler.** `answerPermission` queues the answer instead of resolving it at once, so a resume uses the one-over allowance and is ordered before waiting tasks by the same function that orders starts.

**One worker fiber.** Every trigger becomes a signal to one fiber, and a pass reads and reserves slots in one `SynchronizedRef.modify` before it starts any session, so neither a second pass nor an `emit` handler can change the count between the read and the reservation.

**Event table plus projection.** Issue #179 item 2 and `docs/designs/host-database.md` call for it. The projection serves reads; the events keep the history the decision path (plan step 3) and the org KPIs (plan step 8) read. One transaction keeps them equal.

**The retro is created by `finishTask`.** It is a state rule of the task, so it lives with the task's rows in `work.ts`.

## Rejected Alternatives

* **Schemas in `src/shared`.** #207 moved the org domain into the plugin, and the root `CLAUDE.md` puts a contract only plugins use in the plugin that owns it.
* **A separate `tasks` plugin.** The user chose to keep tasks inside `org` for now.
* **Adding the work members to `Org` under `OrgService`.** Every `OrgService` reader would depend on session control, and `isOrg` would change.
* **A turn ending finishes the task.** A turn also ends when the agent waits for the user's message.
* **Resolving `answerPermission` at once.** It would bypass the cap and the order with waiting tasks.

## Refinement Record

### Round 1

**Applied**
- *Correctness* (B1) — the plugin imported values `@dia/plugin` does not export. Added the Plugin API section and the 0.0.31 bump.
- *Correctness* (B2) — no project source; `host.ts` keeps the latest `Workspace` in a `Ref`.
- *Correctness* (B3) — `ctx.serve` handlers can run twice; ids are caller-generated and every change is safe to repeat.
- *Correctness* (B4) — `SessionNotFound`/`SessionFailed` requeued into an immediate restart loop; `NotFound` clears `sessionId`, `Failed` holds the task until a backend, catalog or user change.
- *Correctness* (B5) — passes could overlap and exceed the cap; one worker fiber, a semaphore, and slots reserved before starting.
- *Correctness* (B6) — late dispatcher writes after `finishTask`; writes are conditional on state, and per-task scopes are created and closed explicitly.
- *Correctness* (M1) — only the user can finish a task in #179; stated under Out, with `TurnParked`.
- *Correctness* (M2) — a question answered from #182 never re-took a slot; any agent event while awaiting with no pending permission sets `turn = 'running'`.
- *Correctness* (M3) — dismissing a hire broke the foreign keys; `ON DELETE SET NULL`, and `HireHasOpenTasks` counts tasks that are not `completed` through `openTasksOf`.
- *Correctness* (M4) — the retro task's fields, the parent's completion, reopening a `completed` objective, and the meaning of `Objective.assignee` are stated.
- *Correctness* (M5) — the backend and catalog wiring are stated, and "Host start" became "plugin setup".
- *Correctness* (m1) — the migration default is the literal `'medium'`; `paneId` is stored on the task; event names agree; `WorkTitle` is defined; pending permissions are in memory only; `mcpServers` assignability is noted.
- *Project rules* (m2, m3) — scheduler logging; `Clock` for times.
- *Information Hiding* (M7) — the work members are not added to `Org`; `running` renamed `heldSlots`.
- *Strategic Programming* (M8, part) — `nextStarts` takes `busyHires` and owns the one-per-hire rule.
- *Law of Demeter* (m4) — `work.ts` returns one `StartContext` per candidate.
- *Temporal Decomposition* (m5) — `TaskSessionStarted` is written only when the session id changes.
- *Define Errors Out of Existence* (m6, part) — `ParentTaskNotFound` merged into `TaskNotFound`.
- *Project rules* (M6, part) — headless sessions in a plugin are recorded as ADR-0067.

**Rejected**
- *Project rules* (M6, part) — "one over the job title's cap never happens departs from ADR-0033". ADR-0033 allows the excess and does not require it, so the model does not contradict it; the wording now says the model never needs the allowance.
- *Strategic Programming* (M8, part) — "the `org_events` table has no reader, so it is speculative". Issue #179 item 2 requires it, as does `docs/designs/host-database.md:124`.
- *Define Errors Out of Existence* (m6, part) — "make `assignTask` on a started task a no-op". Giving a running task to a different hire is a user error that the screen must show; a silent no-op would hide it.

### Round 2

**Applied**
- *Correctness* (1) — a session could take a slot with no check (an answer from #182, a turn after background work); any activity event while not running and with no pending permission sets `turn = 'running'`, and the overshoot is stated.
- *Correctness* (2) — the semaphore did not cover `emit` handlers; the live map is a `SynchronizedRef`, read and reserved in one `modify`, and the semaphore is dropped.
- *Correctness* (3) — two pending permissions on one task; a resume resolves every answered request and stays `awaiting-user` while any is pending.
- *Correctness* (4) — a reassign between reservation and `TaskStarted` left a session running under the wrong hire; `TaskStarted` is conditional on the assignee and closes the session when it changes no row.
- *Correctness* (5) — a repeated `answerPermission` failed; answered ids are kept until the task leaves `running`.
- *Correctness* (6) — `makeOrg` and `makeWork` depended on each other; `work.ts` reads `hired_agents` by SQL and the dispatcher builds the hire half of `StartContext`.
- *Correctness* (7) — raising the cap and the first workspace value had no owner; `host.ts` signals after each change, including `SetOverallCap`, and reads the first workspace before serving.
- *Information Hiding* (8) — `WorkSnapshot` carried dispatcher state; `LiveWork` comes from the dispatcher and `ReadWork` joins them.
- *Correctness* (9) — `emit` handlers also write `TaskSessionStarted`; `finishTask` removed from the `failed` reset list.
- *Correctness* (10) — `HireHasOpenTasks.tasks` typed; a hire with a `finished` task cannot be dismissed until its retro completes.
- *Project rules* (11) — call payloads, results and events are schemas with derived types.
- *Project rules* (12) — Tests section added.
- *Correctness* (14) — "only module that calls `AgentBackend`" became "only module that opens sessions" (`bypass.ts` calls it).

**Rejected**
- *Minimize Complexity* (13) — "drop `NewTask.parentTaskId` and `Objective.assignee` until #181". Issue #179 item 1 lists both fields in the schemas.
- *Names as Documentation* — "rename `Work` to `Objectives`". The module owns objectives and tasks; `Work` names both.
- *Correctness* (not checked by the critic) — whether added `@dia/plugin` exports need a `PLUGIN_API_VERSION` bump. `docs/designs/mcp-plugin.md:122` bumped it for `@dia/renderer-plugin` gaining `useProvided`, an added export, so the bump stays.

### Round 3

**Applied**
- *Correctness* (1, blocker) — "`PaneAgentEvent` content" is not an `OutboundMessage`; activity events are named, and every other tag is listed as not changing `SlotState` (checked against `protocol.ts`).
- *Correctness* (2, blocker) — `Work` could not forward to a dispatcher built after it; `AnswerPermission` is served from `dispatcher.answerPermission`.
- *Correctness* (3) — `SessionStarted` could arrive before `TaskStarted` committed; `TaskStarted` is written before `openSession`, which also removes the close-on-mismatch branch.
- *Correctness* (4) — the answered input, queue and ids were three unnamed things; named `pending`, `queuedAnswers`, `answeredIds`, with the `answered` order and the one-slot charge stated.
- *Correctness* (5) — a permission answered from #182's tab would leave its entry pending; the example is a question or plan review, and permissions are answered only through `AnswerPermission`.
- *Correctness* (6) — `makeWork` takes the workspace `Ref`; `HireNotFound` listed; `startCandidates` returns waiting tasks and `busyHires` together.
- *Correctness* (7) — Decomposition no longer says `work.ts` builds `StartContext`.
- *Project rules* (8) — ADR-0067, JSDoc and logging added to Scope.
- *Project rules* (9) — tests for the new slot cases, repeated calls and host signalling.
