# `dia-org` plugin

Issue: draekien/dia#252, step 14 of `docs/plans/2026-11-13-foundation.md` (parent #237). Decisions: ADR-0080, ADR-0076, ADR-0069, ADR-0071, ADR-0053, ADR-0064.

`dia-org` is the org plugin moved back from `archive/org` and rewritten over the foundation. It owns hires, job titles, the org chart, onboarding, the Dashboard, the Executive assistant and routing. It runs no agent session itself: an issue assigned to a hire becomes a run through `dia-run-queue`, the run's requests reach `dia-inbox` because every run's requests do, and the issue tools reach the run through `dia-tools`. It removes `dispatcher.ts`, `scheduler.ts`, `session-tools.ts` and the `PendingPermission`, `LiveWork`, `PermissionNotPending` and `MissingReference` schemas.

## Success criteria

| # | Criterion | Observed in |
| --- | --- | --- |
| 1 | A `todo` issue assigned to a hire is enqueued with `run.cwd` = the issue's worktree (or the project directory when the project does not run issues in worktrees), `key: { id: hireId, limit: 1 }` and context `{ issueId, assigneeId: hireId }`; once the queue returns the run id, the issue moves to `understanding` | `issue-runs.test.ts`; app |
| 2 | The `org` provider's issue tools are registered with `dia-tools` for `isIssueToolScope`, so a run's `update_issue` call receives its issue and hire through `ToolScope.context` | `host.test.ts`; app |
| 3 | A permission request from such a run appears in the inbox | app (`dia-inbox` lists every run's requests) |
| 4 | The assistant's `objective_create` with route direct creates an objective and a `work` issue assigned to the hire, which then starts by criterion 1 | `routing-tools.test.ts`, `issue-runs.test.ts`; app |
| 5 | Hires and job titles from `<userData>/plugins/org` are present after first start, at `<userData>/plugins/dia-org` | app, scratch profile seeded with a copy of the real `plugins/org` |
| 6 | No file under `plugins/dia-org` calls `openSession` | `host.test.ts` reads the plugin's sources |

Supporting: a run started for an issue that left `todo` while queued is closed at once; an issue whose stored run is live or mid-turn is marked started without another run; an idle stored run is resumed with `RESUME_TEXT`; a stored run that no longer exists or is archived is replaced by a new run; `issue_worktrees` paths under a moved folder are rewritten.

## Decisions taken without the user

D1. **A run per issue, started through the queue; a re-start of the same hire's issue reuses its stored run.** `issue_runs (issue_id, hire_id, run_id)` records each issue's run. For a startable issue whose row names the same hire, the pass reads `runs.list`: a run whose `status` is `running` or `waiting` (mid-turn, or recovery will resume it) is only marked started; an `idle` run, live or not, is resumed with `runs.send(runId, RESUME_TEXT, 'queue')`, outside the queue, then marked started; a missing or `archived` run has its row deleted and the issue gets a new run. Any other startable issue gets a new run through `queue.enqueue`. Alternative: always a new run (rejected: a reworked issue loses its conversation, which the old dispatcher kept through `sessionId`). Alternative: a resume in the queue (rejected: a foundation change no criterion needs). Consequence: a resumed run is not held by the per-hire limit, and after a `dia-run-queue` reload or a restart the queue does not count a hire's existing runs against its key (D5 of `dia-run-queue.md`).

D2. **The first pass waits for `ctx.pluginsSettled`.** `dia-runs` provides `RunsKey` before it forks recovery (`plugins/dia-runs/host.ts`), so `isLive` alone would miss a run about to be recovered; D1 reads the stored status instead, and waiting for settled plugins keeps the first pass from racing the rest of startup.

D3. **The issue is marked started after its run starts, and the `issue_runs` row is written first.** While queued the issue stays `todo`, so the Issues page shows no work that has not begun. An issue id stays in an in-flight set from `enqueue` until the row and `markStarted` complete; passes skip in-flight ids and run one at a time. An issue that leaves `todo` (or changes hire) while queued is not interrupted: once its run starts, `markStarted` returns `false` and the run is closed at once and its row deleted. Interrupting the waiting `enqueue` would remove an entry the queue has not picked, but an interrupt that lands after the pick loses the run id (`docs/reasoning/2026-11-13-run-queue-enqueue-interrupt-loses-run-id.md`), leaving a run no row names. Closing the plugin's scope still interrupts every waiting start. Alternative: mark first and requeue on failure (rejected: a long queue shows many issues as `understanding`).

D4. **A run ends; its issue stays where the agent left it.** When a turn ends with the issue still started, nothing moves it; the user moves it or reassigns it, as with the old dispatcher. A pass closes (`runs.close`) the live run of every row whose issue is neither started nor startable for that row's hire, and deletes the row. A startable issue whose hire, listed job title or registered project is unknown waits with a logged warning, as before.

D5. **Job titles shape a run through its start options and first message only** (ADR-0080). `StartRunOptions` has no system prompt, plugin, MCP server or allow-list field, so a job title's model, thinking level and bypass opt-in set the run's options, its job description leads the first message, and its MCP servers, skills and allow/deny lists are not applied. Alternative: extend `StartRunOptions` and the stored run row in `dia-runs` (rejected for this step: a foundation change through `dia-runs` recovery; follow-up). Consequence: in `default` mode each dia tool call asks the user, and the request reaches the inbox; in `auto` the classifier decides.

D6. **The permission mode is `startPermissionMode`** (ADR-0054) from the model catalog and `disabledPermissionModes`, read from `AgentBackendKey` (no `openSession`), for hires and the assistant. ADR-0071's `dontAsk` for the assistant goes (ADR-0080): without its allow list `dontAsk` refuses the routing tools.

D7. **The overall cap sets the queue's limit.** `SetOverallCap`, and each provision of `RunQueueKey`, call `queue.setLimit(cap)`. The queue counts every busy run, so the user's own busy tabs now hold back hires too. Alternative: drop the cap (rejected: Settings › Org and the Dashboard show it).

D8. **The Executive assistant is a run started on the first request** (ADR-0080). `AskAssistant { text }` starts it with `runs.start` (not queued: the user waits for it) in `<dataDir>/assistant`, labelled `dia-org-assistant`, or sends `text` to the stored run when `runs.list` shows it and it is not archived. The renderer then calls `OpenRunInTab` of `dia-runs`. The routing tools are registered for scopes with that label. `StartOverAssistant` archives the run and forgets it. Alternative: open it at plugin start (rejected: there is no attach API any more, and an idle run costs nothing until asked). Consequence: showing it in a tab adds `<dataDir>/assistant` as a project (`showRunInTab` probes an unknown directory); the old assistant conversation is not resumed.

D9. **Notices are prefixed to the next `AskAssistant` text**, not shown in a pane: runs have no notice event. Alternative: send each notice to the run (rejected: a turn per notice).

D10. **`objective_attach` sends to the live runs of the objective's started issues** with `runs.send(runId, message, 'queue')`. Handover of new work stays through issues (ADR-0069, ADR-0071); `run_send`, `run_wait` and `run_delegate` are not used.

D11. **Data folder.** Manifest `dataMigrations: [{ id: '1_dia_prefix', from: 'plugins/org' }]`. `ctx.onPathsMoved` rewrites `issue_worktrees.path` with `relocatePath` (the worktrees moved with `dia-worktrees`).

D12. **A new issue run is shown in a tab of the objective's project, without selecting it.** After `markStarted` succeeds for a run `queue.enqueue` returned, the pass calls `runs.openInTab(runId, { projectDirectory, select: false })`, where `projectDirectory` is the directory of the objective's project that `IssueWorkspace.open` returned with the run's `cwd`. The tab works in the issue's worktree and is listed under that project in the agent overview. A run reused per D1 is not opened again. Alternative: list tab-less runs in the agent overview (rejected by the user: it needs a run list feed and a run-to-project mapping, and a click still opens a tab). Consequence: the tab stays after the issue leaves the started statuses, until the user archives it; archiving it archives the run, so a still-startable issue gets a new run per D1.

## Interface

### Kept (moved with `git mv`, imports renamed to `dia-*`)
`org.ts`, `service.ts` (`OrgService`), `domain.ts` (minus the removed schemas), `migrations.ts` (+ `12_runs`: `issue_runs` and `assistant_run`), `handover.ts`, `assignees.ts`, `built-in-job-titles.ts`, `bypass.ts`, `issue-workspace.ts`, `routing-tools.ts` (on `diaTool` with `Schema.Struct` inputs), every renderer file.

### `issue-runs.ts` (replaces `dispatcher.ts` and `scheduler.ts`)

```ts
/** What a hire's run of an issue starts with, or none while it cannot start yet. */
export type StartOptionsOf = (issue: Issue, objective: Objective, hire: HiredAgent, jobTitle: JobTitle) =>
  Effect.Effect<Option.Option<StartRunOptions>>

/** Starts each startable org issue as a run and keeps runs in step with issue statuses. */
export const runIssues: (deps: {
  readonly org: Pick<Org, 'jobTitles' | 'hiredAgents' | 'watchJobTitleChanges' | 'watchHireChanges'>
  readonly issues: Pick<Issues, 'watchChanges'>
  readonly provider: Pick<ProviderIssues, 'runState' | 'markStarted'>
  readonly workspace: Pick<IssueWorkspace, 'retain'>
  readonly startOptions: StartOptionsOf
  readonly runs: Pick<Runs, 'list' | 'isLive' | 'send' | 'close'>
  readonly queue: Pick<RunQueue, 'enqueue'>
}) => Effect.Effect<IssueRuns, never, Scope.Scope | SqlClient.SqlClient>

/** The live runs of org issues. */
export interface IssueRuns {
  /** Sends `text` to issue `issueId`'s live run; false when it has none. */
  readonly deliver: (issueId: IssueId, text: string) => Effect.Effect<boolean>
}
```

`startOptions` (`issueStartOptions` in `run-options.ts`) opens the issue's workspace and returns none while it waits, then computes the permission mode and the first message. A pass runs after `ctx.pluginsSettled` and after each change of issues, hires or job titles; it reads `provider.runState`, closes runs per D4, calls `workspace.retain`, and starts each startable issue per D1.

### `assistant.ts`

```ts
/** The org's Executive assistant run (ADR-0071, ADR-0080). */
export interface Assistant {
  /** Records that the assistant created objective `objectiveId`, so its changes produce notices. */
  readonly claim: (objectiveId: ObjectiveId) => Effect.Effect<void>
  /** Sends `text`, after any pending notices, to the assistant run, starting it if needed; returns its id. */
  readonly ask: (text: string) => Effect.Effect<string, AssistantDisabled>
  /** Archives the assistant run; the next `ask` starts a new one. */
  readonly startOver: Effect.Effect<void>
}
```

### `calls.ts`
Removed: `AnswerPermission`. `OrgLive` becomes `{ assistantEnabled, assistantRunId, teamHasWork }`. Added: `AskAssistant { text } → runId` (error `AssistantDisabled`), `StartOverAssistant`.

### Host wiring
`whenProvided([IssuesKey])` hands work over and registers the provider as before; inside it, `whenProvided([ToolsKey])` registers `provider.issueTools` with `when: isIssueToolScope`, and `whenProvided([RunsKey, RunQueueKey, AgentBackendKey])` runs `runIssues`, sets the queue limit, builds the assistant, and (with `ToolsKey`) registers the routing tools, whose `objective_attach` uses that scope's `deliver`, for the assistant label.

## Refinement record

Round 1 (subagent, sonnet):
- B1 a pass between `enqueue` and `markStarted` enqueues the issue again — applied (D3 in-flight set, serial passes).
- B2 interrupting after the pick loses the run id — applied (D3: a queued issue is not interrupted; its run is closed when it starts).
- B3 closing the run when `markStarted` fails — applied (D3: row first, close only via D4).
- B4 `isLive` races recovery; `send` to a missing or archived run does nothing — applied (D1 reads `runs.list`; D2).
- M5 silent skip of issues with an unknown hire, job title or project — rejected: the old dispatcher skipped them with a warning, a dismissed hire cannot hold an open issue, and refusing would move an issue to triage while a project is only temporarily unregistered. D4 states the behaviour.
- M6 contradicts ADR-0071 and ADR-0064 without an ADR — applied (ADR-0080).
- M7 `deliver` outlives its scope — rejected as stated: the routing tools are registered in the same inner scope; the wiring now says so.
- M8 every dia tool call asks the user — applied as a consequence in D5.
- M9 `ask` to a missing run — applied (D8 checks `runs.list`).
- Minors: narrower `Pick`s and `startOptions` instead of the backend — applied; JSDoc — applied; overall-cap consequence — applied (D7).

Implementation: a probe showed that interrupting `enqueue` after the pick loses the run id, so D3 no longer interrupts a queued issue that changes; it closes the run once it starts.

Round 2 (inline): checked D1–D11 against `run-queue.ts` `enqueue` (an interrupt after the pick returns the id), `runs-seam.ts` `RunInfo.status` and `live`, `service.ts` `markStarted`. No blocker or major found.
