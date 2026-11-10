# Issues plugin

`plugins/issues` owns objectives, issues and comments: their store, their statuses (ADR-0069), the agent issue tools, an assignee provider registry, and an Issues page. It imports nothing from `org`. `org` registers its hired agents as the assignee provider `org`, creates the objectives and first issues of its routes through `issues`, runs the issues assigned to its hires, and hands the objectives, issues, comments and events in `org.db` over to `issues`. Issue #223, step 3 of ADR-0072.

Scope: module (a new `issues` plugin with a host and a renderer; changes in `org`; the design-system components in `@dia/renderer-plugin`). Decisions confirmed by the user on 2026-11-09:

1. The run fields (`paneId`, `sessionId`, the refusal) and the run transitions stay on the issue in `issues`, and only the provider that holds an issue's assignee can use them.
2. Finishing a `work` issue creates no `retro` issue. #42 adds retros through `issues`.
3. `issues` has its own Issues page in the sidebar. The Org page loses its Objectives sub-page.
4. The New objective dialog creates the objective only, with no issues and no assignee.
5. The objective screen keeps creating `work` issues, with an optional assignee from any loaded provider.
6. The Issues page uses the `draekien/design-system` components (`List`, `Status`, `Entity`, `RelativeTime`) that `@dia/renderer-plugin` exports.

Assumptions confirmed with the scope:

- `Issue.missing` becomes `refusal: Refusal | null`, where `Refusal` is a trimmed string of 1 to 1000 characters the provider sets and the Issues page shows as it is.
- `Objective.assignee` stays, as an assignee reference; only `org`'s route `direct` sets it.
- A reference whose id its loaded provider no longer lists shows as "Removed assignee"; a reference whose provider is not loaded shows as "<provider id> not loaded".
- `dismiss` keeps refusing while open issues name the hire, and refuses while `issues` is not loaded.
- `org_events` moves to `issues` as its event log. `assistant_objectives` stays in `org` until #224.
- Until `org` and `issues` have both loaded once, objectives, issues and comments stay in `org.db` and the Issues page lists none.
- A new hire becomes an assignable assignee once the provider's `assignees` stream has emitted after `Hire` returns; a route `direct` call before that fails with `AssigneeNotFound`.
- The check and the delete in `dismiss` span two databases and are not atomic; an issue assigned to a hire in that window shows "Removed assignee" and does not start.

Out of scope: retro issues (#42), the `assistant` plugin (#224), assigning to anything other than an `org` hire (no second provider ships), showing pending permissions or held slots in the UI (no screen shows them today).

## Success criteria

1. After the migration of a copy of a real `org.db`, every objective, issue and comment shows on the Issues page with the same title, status, kind and assignee name; `org.db` has no `objectives_handover`, `issues_handover`, `issue_comments_handover` or `org_events_handover` table.
2. Route `plan` creates the objective and an unassigned `Plan: <title>` planning issue; route `direct` creates the objective and one `work` issue for the named hire.
3. A `todo` issue assigned to an `org` hire starts: it moves to `understanding` and its session opens.
4. After the handover has run once, with `org` disabled, `issues` loads and the Issues page lists the objectives; an issue assigned to an `org` hire shows "org not loaded", keeps its assignee, and does not start.
5. The New objective dialog creates an objective with no issues.
6. Finishing a `work` issue creates no `retro` issue.
7. A refused start moves the issue to `triage` and the Issues page shows `Cannot start: missing <name> (MCP server)`.
8. Dismissing a hire that open issues name fails with `HireHasOpenIssues`.
9. The agent issue tools `create_issue`, `update_issue` and `comment_issue` behave as before; a comment's author is `{ provider: 'org', id: <hire id> }`.
10. On the objective screen, the user creates a `work` issue in `todo` with an optional assignee chosen from the loaded providers.

## Current state (read at `origin/main` 717ca7a)

| Location | Holds |
|---|---|
| `plugins/org/domain.ts:213-538` | `ObjectiveId`, `IssueId`, `WorkTitle`, priorities, `IssueKind`, `StartedStatus`, `IssueStatus`, `Objective` and `Issue` with `assignee: HireId \| null`, `Issue.missing`, `NewObjective` with `route`, `NewIssue`, `ProposedIssue`, `IssueChange`, `TriageDecision`, `CommentId`, `IssueComment` with `author: HireId \| null`, `WorkSnapshot`, `LiveWork`, the issue errors |
| `plugins/org/work.ts:201-202,233-301` | `prefixedTitle`; `Work` (createObjective writes the objective and its first issue in one transaction, finishIssue adds the retro) and `IssueRuns`; `ensureHire` reads `hired_agents` |
| `plugins/org/issue-tools.ts`, `plugins/org/tool-input.ts` | `create_issue`, `update_issue`, `comment_issue` for an `IssueToolScope { issueId, objectiveId, hireId }`; `tool-input.ts` is shared with `routing-tools.ts` |
| `plugins/org/dispatcher.ts:157-207,593-606,628-629` | `Dispatcher`; `release` clears `failed` and closes the live session; `requeueRunning` runs once at construction, and sessions close at plugin close |
| `plugins/org/routing-tools.ts:157-160,218` | route `plan` refuses an assignee and uses `PlanRoute.make({ assignee: null })`; `newObjectiveId` runs on every tool run |
| `plugins/org/assistant.ts:54,318,325-345` | `deps.work`; the notice link `{ plugin: 'org', page: 'org', target: objectiveId }`; notices diff two `WorkSnapshot`s |
| `plugins/org/host.ts:75-105,126-160,307-346` | `readWorkView`/`watchWork`; `runAssistant` under `whenProvided([AgentBackendKey])`; the work calls, `AssignIssue` and `FinishIssue` calling `dispatcher.release` |
| `plugins/org/calls.ts:150-219`, `plugins/org/renderer.ts:7,14`, `org-actions.ts`, `org-view.ts`, `org-host.fake.tsx` | `WorkView`, `ReadWork`, `WatchWork` and the work calls; the renderer's `workAtom` |
| `plugins/org/migrations.ts:163-252,316-360` | `objectives`, `issues`, `issue_comments` (assignee and author `REFERENCES hired_agents ON DELETE SET NULL`), `org_events` (`seq INTEGER PRIMARY KEY AUTOINCREMENT`); `issues.missing` is a JSON array, `DEFAULT '[]'`; `assistant_objectives` has no foreign key |
| `src/host/services/database.ts:49` | plugin databases open with `PRAGMA foreign_keys = ON` |
| `src/host/plugins/plugin-exports.test.ts:100-105` | every exported plugin module is listed in `tsconfig.plugin-exports.json` and `tsconfig.web.json` |
| `plugins/org/org-page.tsx:32-36,103-106,163`, `objectives-page.tsx`, `objective-screen.tsx`, `objective-dialog.tsx`, `org-fields.tsx:52` | the Objectives sub-page and its target; no `.tsx` reads `pendingPermissions` or `heldSlots`; `dashboard.tsx:42-44` reads only `assistantMissing` |
| `plugins/org/handover.ts` | the #222 handover pattern |

## Modules

```
plugins/issues/
  plugin.json        name "issues", api "0.0.35", category "feature", host "host.ts",
                     renderer "renderer.ts", load "eager", exports ["domain.ts", "service.ts"]
  domain.ts          export: ids, titles, statuses, AssigneeRef, Objective, Issue, IssueComment,
                     inputs, errors
  service.ts         export: Issues, AssigneeProvider, ProviderIssues, StartableIssue, ImportedEvent,
                     ImportedWork, isIssues, IssuesKey
  calls.ts           internal: the renderer's RPCs and IssuesView
  store.ts           internal: migrations, rows, the event log, the queries
  make-issues.ts     internal: Issues and ProviderIssues over the store
  issue-tools.ts     internal: the agent issue tools (moved from org)
  tool-input.ts      internal: copy of org's tool input helpers (org keeps its own for routing-tools)
  host.ts            internal: database, workspace, provide IssuesKey, serve calls
  renderer.ts        internal: PagesSlot entry `issues`
  issues-page.tsx, objective-screen.tsx, objective-dialog.tsx, assignee-select.tsx,
  issue-actions.ts   internal: the page (moved from org)
plugins/org/
  routing-tools.ts, assistant.ts   work over Issues
  dispatcher.ts      runs over a lent ProviderIssues
  scheduler.ts, scheduler.test.ts  import IssueId, ObjectivePriority, PRIORITY_RANK from @dia-plugin/issues/domain
  agents-page.tsx    shows IssuesNotLoaded
  handover.ts        adds handOverWork
  migrations.ts      adds 10_issues_handover
  org.ts, service.ts holdIssues, watchHireChanges; makeOrg loses openIssuesOf
  host.ts, calls.ts, renderer.ts, org-page.tsx, org-view.ts, org-actions.ts, dashboard.tsx,
  org-fields.tsx, org-host.fake.tsx, and the tests over Work
tsconfig.plugin-exports.json, tsconfig.web.json   list plugins/issues/{domain,service}.ts
docs/adr/0072-…md  amendment note
docs/glossary.md
```

`@dia-plugin/*` already resolves any plugin directory: `tsconfig.node.json`, `tsconfig.test.json`, `tsconfig.web.json` and `tsconfig.plugin-exports.json` map it, `vitest.config.ts` aliases it, and the `diaPluginExports` Vite plugin resolves each file a manifest lists in `exports`. No alias changes. Every export carries a JSDoc stating its purpose, inputs, outputs and when to call it; every exported type is `typeof XSchema.Type`; tagged values are built with `.make`.

## Interface

### `plugins/issues/domain.ts`

Moved from `org/domain.ts` unchanged: `ObjectiveId`, `IssueId`, `WORK_TITLE_MAX_LENGTH`, `WorkTitle`, `ObjectivePriority`, `PRIORITY_RANK`, `PRIORITY_LABELS`, `ObjectiveState`, `IssueKind`, `StartedStatus`, `IssueStatus`, `isAssignable`, `isStarted`, `isClosed`, `ISSUE_DESCRIPTION_MAX_LENGTH`, `IssueDescription`, `ProposedIssue`, `IssueChange`, `TriageDecision`, `CommentId`, `COMMENT_BODY_MAX_LENGTH`, `CommentBody`, `ObjectiveNotFound`, `IssueNotFound`, `ProjectNotFound`, `IssueNotAssignable`, `IssueNotStarted`, `IssueNotInTriage`, `IssueClosed`.

New or changed:

```ts
/** A registered assignee provider's id: lowercase letters, digits and `-`, 1–40 characters. */
export const ProviderId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/)), Schema.brand('ProviderId'))

/** Who an issue or objective is given to, or who wrote a comment: an id the provider `provider` lists. */
export const AssigneeRef = Schema.Struct({ provider: ProviderId, id: Schema.NonEmptyString })

/** The longest a {@link Refusal} may be, in characters. */
export const REFUSAL_MAX_LENGTH = 1000
/** Why the provider refused to start an issue, shown as it is: trimmed, 1 to REFUSAL_MAX_LENGTH characters. */
export const Refusal = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(REFUSAL_MAX_LENGTH)), Schema.brand('Refusal'))

Objective = { id, projectId, title, description, priority, assignee: NullOr(AssigneeRef), state, createdAt }
Issue     = { id, objectiveId, parentIssueId, kind, title, description, status,
              assignee: NullOr(AssigneeRef), paneId, sessionId, refusal: NullOr(Refusal), createdAt }
              // refusal is non-null only while status is 'triage'
IssueComment = { id, issueId, author: NullOr(AssigneeRef), body, createdAt }

/** One of the issues an objective is created with: `work`, or the objective's `planning` issue. */
FirstIssue    = { kind: Literals(['work', 'planning']), title, description, assignee: NullOr(AssigneeRef) }
/** A `work` issue added to an existing objective, optionally under `parentIssueId`. */
NewWorkIssue  = { id, objectiveId, parentIssueId, title, description, assignee: NullOr(AssigneeRef) }
NewObjective  = { id, projectId, title, description, priority, assignee: NullOr(AssigneeRef) }

/** One assignee a provider lists now: its `id`, the `name` to show, and `detail` under it (the org shows the job title). */
export const ListedAssignee = Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString, detail: Schema.String })

/** Every objective, issue and comment, each in creation order. */
IssuesSnapshot = { objectives, issues, comments }

/** The assignees one held provider lists now, with its label. */
AssigneeGroup = { provider: ProviderId, label: String, assignees: ListedAssignee[] }

/** Failure of assigning or creating: no loaded provider lists `assignee`. */
export class AssigneeNotFound extends Schema.TaggedError<AssigneeNotFound>()('AssigneeNotFound', { assignee: AssigneeRef }) {}
/** Failure of registering a provider: another holds `provider`. */
export class AssigneeProviderTaken extends Schema.TaggedError<AssigneeProviderTaken>()('AssigneeProviderTaken', { provider: ProviderId }) {}
```

### `plugins/issues/service.ts`

```ts
/** An assignee provider: its id, the label the Issues page shows, and the assignees it lists now and after each change. */
export interface AssigneeProvider {
  readonly id: ProviderId
  readonly label: string
  readonly assignees: Stream.Stream<ReadonlyArray<ListedAssignee>>
}

/**
 * The objectives, issues and comments, and the assignee providers that run them. Read it with
 * `ctx.whenProvided([IssuesKey], …)`. A database failure is a defect. `createIssue` reopens a
 * completed objective; `assignIssue` needs an issue in `triage` or `todo`; `finishIssue` moves a
 * started issue to `done` and creates nothing; `stopObjective` cancels the objective's open issues.
 */
export interface Issues {
  readonly snapshot: Effect.Effect<IssuesSnapshot>
  /** Emits once after each committed change to objectives, issues or comments, and each provider registration, release or assignee list change. */
  readonly watchChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  /** The held providers by label, with the assignees each lists now. */
  readonly providers: Effect.Effect<ReadonlyArray<AssigneeGroup>>
  /**
   * Creates an open objective and `firstIssues` (each in `todo`, all in `objective.id`, no
   * `parentIssueId`) in one transaction. A repeated `id` returns the stored objective and creates nothing.
   */
  readonly createObjective: (input: NewObjective, firstIssues: ReadonlyArray<FirstIssue>) => Effect.Effect<Objective, ProjectNotFound | AssigneeNotFound>
  readonly createIssue: (input: NewWorkIssue) => Effect.Effect<Issue, ObjectiveNotFound | IssueNotFound | AssigneeNotFound>
  readonly assignIssue: (issueId: IssueId, assignee: AssigneeRef | null) => Effect.Effect<Issue, IssueNotFound | IssueNotAssignable | AssigneeNotFound>
  readonly triageIssues: (issueIds: NonEmptyReadonlyArray<IssueId>, decision: TriageDecision) => Effect.Effect<ReadonlyArray<Issue>, IssueNotFound | IssueNotInTriage>
  readonly finishIssue: (issueId: IssueId) => Effect.Effect<Issue, IssueNotFound | IssueNotStarted>
  readonly stopObjective: (objectiveId: ObjectiveId) => Effect.Effect<ReadonlyArray<Issue>, ObjectiveNotFound>
  /**
   * Holds `provider` until the calling scope closes and returns the run API for the issues
   * assigned to it. Call it inside `whenProvided([IssuesKey], …)`. When the scope closes, every
   * started issue assigned to the provider other than `in_review` returns to `todo`, keeping its session.
   * Returns after the provider's first `assignees` emission is stored, so every assignee it lists
   * is valid from the moment this effect succeeds. A stream that ends before its first emission
   * lists no assignees; after a stream ends, its last list stands.
   */
  readonly registerProvider: (provider: AssigneeProvider) => Effect.Effect<ProviderIssues, AssigneeProviderTaken, Scope.Scope>
  /**
   * Adds `work` taken from another plugin's store in one transaction, skipping every row already
   * stored, so running it again adds nothing. Only for a one-time move; it does not start or
   * change any issue.
   */
  readonly importWork: (work: ImportedWork) => Effect.Effect<void>
}

/** One event from another plugin's event log: its `seq` there, when it happened, and its text. */
ImportedEvent = { seq: Int, at: Number, objectiveId: ObjectiveId, issueId: NullOr(IssueId), event: String }
/** The objectives, issues, comments and events {@link Issues.importWork} adds. */
ImportedWork  = { objectives: Objective[], issues: Issue[], comments: IssueComment[], events: ImportedEvent[] }

/** A `todo` issue assigned to the provider, and its objective. */
export interface StartableIssue { readonly issue: Issue; readonly objective: Objective }

/**
 * The issues assigned to one provider, and the run transitions on them. Each transition changes
 * an issue only in the status it expects and only when its assignee's provider is this one, and
 * reports whether it did: `markStarted` todo → understanding for `assigneeId`; `markSessionStarted`
 * stores the session a started issue resumes; `markRequeued` started (not `in_review`) → todo,
 * keeping or clearing the session; `requeueRunning` does that for every such issue of the
 * provider and returns the count; `markRefused` todo → triage with `refusal`.
 */
export interface ProviderIssues {
  /** The startable issues, and the started issues assigned to this provider. */
  readonly runState: Effect.Effect<{ readonly startable: ReadonlyArray<StartableIssue>; readonly started: ReadonlyArray<Issue> }>
  readonly markStarted: (issueId: IssueId, assigneeId: string) => Effect.Effect<boolean>
  readonly markSessionStarted: (issueId: IssueId, sessionId: SessionId) => Effect.Effect<boolean>
  readonly markRequeued: (issueId: IssueId, keepSession: boolean) => Effect.Effect<boolean>
  readonly requeueRunning: Effect.Effect<number>
  readonly markRefused: (issueId: IssueId, refusal: Refusal) => Effect.Effect<boolean>
  /** How many issues assigned to `assigneeId` are neither `done` nor `canceled`. */
  readonly countOpenIssues: (assigneeId: string) => Effect.Effect<number>
  /** The agent issue tools for a session working on `issueId` as `assigneeId`. */
  readonly issueTools: (issueId: IssueId, assigneeId: string) => ReadonlyArray<DiaTool>
}

/** Whether `value` has every {@link Issues} member. */
export const isIssues = …
/** The key the `issues` plugin provides its {@link Issues} under: `issues`. */
export const IssuesKey = ServiceKey.make('issues', isIssues)
```

### `plugins/issues/calls.ts` (internal)

```ts
IssuesView    = { ...IssuesSnapshot.fields, providers: AssigneeGroup[] }

ReadIssues, WatchIssues (stream; emits on Issues.watchChanges)  → IssuesView
CreateObjective { objective: NewObjective }        → Objective | ProjectNotFound | AssigneeNotFound   // firstIssues = []
CreateIssue     { issue: NewWorkIssue }            → Issue     | ObjectiveNotFound | IssueNotFound | AssigneeNotFound
AssignIssue     { issueId, assignee: NullOr(AssigneeRef) } → Issue | IssueNotFound | IssueNotAssignable | AssigneeNotFound
TriageIssues    { issueIds, decision }             → Issue[]   | IssueNotFound | IssueNotInTriage
FinishIssue     { issueId }                        → Issue     | IssueNotFound | IssueNotStarted
```

### `org`

- `org/domain.ts`, `dispatcher.ts`, `scheduler.ts`, `routing-tools.ts` and `assistant.ts` import every moved name they use (`IssueId`, `ObjectiveId`, `Issue`, `Objective`, `IssuesSnapshot`, `WorkTitle`, `WORK_TITLE_MAX_LENGTH`, `ObjectivePriority`, `PRIORITY_RANK`, `ISSUE_DESCRIPTION_MAX_LENGTH`) from `@dia-plugin/issues/domain`. `org/domain.ts` keeps hire and job title types, `MissingReference`, `describeMissing`, `OverallCap`, `HireNotFound`, `HireHasOpenIssues`, `PermissionNotPending`, `PendingPermission`, `LiveWork`, and `PlanRoute`, `DirectRoute`, `ObjectiveRoute`.
- `org` owns `prefixedTitle` (moved from `work.ts`): `<prefix>: <title>` cut to `WORK_TITLE_MAX_LENGTH` and trimmed.
- `org` builds a refusal with `refusalOf(missing)`: `Cannot start: missing <describeMissing(missing)>` cut to `REFUSAL_MAX_LENGTH` and trimmed.
- `org/domain.ts` adds `IssuesNotLoaded` (`Schema.TaggedError`, no fields): dismissing is refused while no `ProviderIssues` is held. `Org.dismiss` is `Effect<void, HireNotFound | HireHasOpenIssues | IssuesNotLoaded>` (`service.ts:84`), the `Dismiss` Rpc error is `Schema.Union([HireNotFound, HireHasOpenIssues, IssuesNotLoaded])` (`calls.ts:111`), and `agents-page.tsx` shows "Issues is not ready; it cannot be checked whether this agent has open issues".
- `Org` gains `holdIssues: (issues: Pick<ProviderIssues, 'countOpenIssues'>) => Effect<void, never, Scope>`, added to `isOrg`'s members, following `holdDefinitions` (`service.ts:56`). `makeOrg` loses its `openIssuesOf` parameter (`org.ts:126`). `dismiss` calls the held `countOpenIssues` and fails with `IssuesNotLoaded` when none is held.
- `org` defines `ORG_PROVIDER = ProviderId.make('org')` and builds every reference with `AssigneeRef.make({ provider: ORG_PROVIDER, id })`, in the routes, the provider registration and `handOverWork`.
- `Org` gains `watchHireChanges: Effect<Stream<void>, never, Scope>` (added to `isOrg`'s members in `service.ts`), published after `hire`, `dismiss` and `renameHire`. The provider's `assignees` is `Stream.unwrap` of: subscribe to `watchHireChanges` and `watchJobTitleChanges`, read the list, emit it, then emit a re-read list after each change.
- `calls.ts` drops `WorkView`, `ReadWork`, `WatchWork`, `CreateObjective`, `CreateIssue`, `AssignIssue`, `TriageIssues`, `FinishIssue`, and adds `WatchOrgLive → { assistantMissing }`. `AnswerPermission` and `Dispatcher.live` stay.
- `Dispatcher.lendIssues(issues: Pick<Issues, 'watchChanges'>, runs: ProviderIssues): Effect<void, never, Scope>` replaces `deps.runs`; `release` is removed.

## Behaviour

### Store and statuses

`issues` stores `objectives` (`assignee_provider` and `assignee_id`, both null or both set), `issues` (`assignee_provider` and `assignee_id`, both null or both set; `refusal` null unless `status = 'triage'`), `issue_comments` (`author_provider`, `author_id`) and `issue_events` (`seq`, `at`, `objective_id`, `issue_id`, `event`, `imported_seq INTEGER UNIQUE`) in its own database. Each change is one transaction that writes its event and its rows and is safe to repeat, as `work.ts` is today. `createObjective` creates the objective and its `firstIssues`. `createIssue` creates a `todo` `work` issue, reopening a completed objective. `finishIssue` moves a started issue to `done` and creates nothing. `proposeIssue`, `updateIssue` and `commentIssue` are reached only through the agent issue tools. An objective completes once it has issues and all are closed.

### Assignee providers

`registerProvider` holds the provider until its scope closes; while held, `issues` follows its `assignees` stream. An assignee is valid for `assignIssue`, `createIssue` and `createObjective` only while a held provider lists its id; otherwise they fail with `AssigneeNotFound`. A stored reference is never rewritten: when the provider closes or stops listing the id, the issue keeps it. On release, the provider's started issues other than `in_review` return to `todo` with their session kept, so no issue other than an `in_review` one stays started without a session.

The release runs SQL on the `issues` database, so the registering plugin's `whenProvided` scope must close before `issues` closes its database. `unload` already closes dependants first; closing the scope a `PluginRegistry` was made in (app shutdown, a test's scope) now unloads every plugin the same way, the last loaded first, instead of closing each plugin's scope in reverse load order without its dependants.

### Running issues (org)

One `whenProvided([IssuesKey], …)` setup in `org` runs, in order:

1. `handOverWork(issues)`, which does nothing when no handover table exists;
2. `registerProvider({ id: ORG_PROVIDER, label: 'Org', assignees })`, where `assignees` lists every hire as `{ id: hireId, name: agentName, detail: job title name }` and emits after each hire, dismissal, rename and job title change; then `org.holdIssues(runs)`;
3. `dispatcher.lendIssues(issues, runs)`;
4. `runAssistant`, as a `whenProvided([AgentBackendKey], …)` nested inside this setup (`api.ts:76-87` allows it).

A `handOverWork` that fails or runs past the setup time limit ends the setup, and the registry logs it; no provider is registered, no issue starts and the assistant does not run until `issues` or `org` is reloaded.

`lendIssues` first calls `requeueRunning`, so a started issue with no live session returns to `todo` keeping its session. It then subscribes to `issues.watchChanges`, signals one pass, and runs a pass after each emission, as `lendBackend` ends with `yield* signal` (`dispatcher.ts:561`). Each pass first reconciles: it closes the live session of every issue no longer in `runState.started` with the assignee it started with, and removes from `failed` every issue that is not in `todo` or whose assignee changed since it failed; `failed` becomes `Map<IssueId, assigneeId>`. This replaces `release`. When the lend scope closes, the dispatcher closes every live session without writing to the store and clears `failed`; with nothing lent, nothing starts. A refused start calls `markRefused(issueId, refusalOf(missing))`.

### Routes and the assistant (org)

Route `plan` calls `createObjective({ …, assignee: null }, [{ kind: 'planning', title: prefixedTitle('Plan', title), description: '', assignee: null }])`. Route `direct` calls `createObjective({ …, assignee }, [{ kind: 'work', title, description: first ISSUE_DESCRIPTION_MAX_LENGTH characters, assignee }])` with `assignee = AssigneeRef.make({ provider: ORG_PROVIDER, id: hireId })`; `AssigneeNotFound` keeps today's text "That hired agent was dismissed.". Stopping an objective calls `stopObjective`; the dispatcher closes the sessions on its next pass. `runAssistant` runs in the `IssuesKey` setup after `handOverWork`, so its first snapshot already holds the handed-over work (no spurious notices from `noticesBetween`, `assistant.ts:84-100,339`), and the assistant session detaches when `issues` closes and attaches again when it is provided and the handover has succeeded. `objectives_read` names an assignee whose provider is `org` and whose hire exists, and writes `nobody` for null and `<provider>` otherwise. `noticesBetween` takes `IssuesSnapshot`; the notice link is `{ plugin: 'issues', page: 'issues', target: objectiveId }`.

### Migration and handover

`org`'s migration `10_issues_handover` renames `objectives`, `issues`, `issue_comments` and `org_events` to `*_handover`; with `legacy_alter_table` off, SQLite rewrites the foreign keys between them. `workHandoverPending` (new, next to the unchanged `handoverPending` that checks `job_titles_handover`) is true while any of the four exists. `handOverWork` reads them, maps each `assignee`/`author` hire id to `{ provider: 'org', id }`, decodes each `missing` JSON array and maps a non-empty one to `refusalOf(missing)` and an empty one to null, and calls `importWork`. It then drops, in one transaction, `issue_comments_handover`, `issues_handover`, `objectives_handover`, `org_events_handover`, in that order. A run after a crash before the drop imports nothing twice.

### UI

- `issues/renderer.ts` adds the PagesSlot entry `{ id: 'issues', label: 'Issues', order: 11 }`; its `target` is an objective id. It follows `WatchIssues`.
- The Issues page shows the objectives list, and opening a row replaces the list with that objective's screen, which has an "Objectives" back button. A `target` objective id opens on that objective's screen.
- The objectives list is a `List` with one `ListRow` per objective: `ListRowName` the title, `ListRowDescription` the project name, facts `Status` (open: fill half; completed: fill full), the priority label, and `RelativeTime` with `dateTime` the ISO string of `createdAt` and `now` an ISO string read once per render, both from Effect `DateTime`.
- The objective screen shows the issues as an indented tree, not a `List`: an issue has no page for a `ListRowLink` to open, and its row holds an assignee select and triage controls that `List` has no column for. Each row shows `Status` with fill none for `triage`, `todo` and `canceled`, half for the six started statuses, full for `done`; the refusal under the title in `triage`. The assignee is an `AssigneeSelect` while the issue can be assigned, and an `Entity` otherwise. The screen has an Add issue form whose assignee is an `AssigneeSelect` over every held provider.
- `AssigneeSelect` groups listed assignees by provider label. A stored reference shows "Removed assignee" when its provider is held and does not list the id, and "<provider id> not loaded" when its provider is not held.
- The New objective dialog drops the assignee field and creates the objective with no first issues.
- The Org page drops `ObjectivesView` (`org-view.ts`, `org-page.tsx`) and `workAtom`; the Dashboard follows `WatchOrgLive`.

### Logging

`issues` logs at Info each provider registered and released, each import (rows offered and added), each requeue on release (count); at Warning each assign refused with `AssigneeNotFound`. `org` logs at Info the handover counts and each lend and withdrawal of `ProviderIssues`, and at Debug each session the reconcile closes.

### Glossary and ADR

`docs/glossary.md` rewrites its Scope line to name `issues` and `org`, points the Issue statuses section at `plugins/issues/domain.ts`, scopes Objective, Issue, Sub-issue, Planning issue, Triage and Comment to the `issues` plugin, changes Comment to "text an assignee attaches to an issue", changes Assignee to "an assignee reference: an id an assignee provider lists; the org lists its hired agents", adds Assignee provider, changes Planning issue to "created by route `plan`", and marks Retro issue as created by #42. ADR-0072's "More Information" gets: "Amended 2026-11-09 by #223: `issues.registerProvider` returns the provider's `ProviderIssues`, because only the registering provider may run its issues; `issues` has its own Issues page; the Executive assistant's notices (ADR-0071) link to the Issues page; finishing a `work` issue creates no retro until #42."

## Tests

| Criterion | Test |
|---|---|
| 1 | `plugins/org/handover.test.ts`: maps assignees, authors and refusals, drops the tables in order, runs twice without duplicate rows or events; `plugins/org/migrations.test.ts`: `10_issues_handover` renames with foreign keys on; app run on a copied `org.db` |
| 2 | `plugins/org/routing-tools.test.ts` over a real `Issues` on an in-memory database, including a 120-character title |
| 3, 7 | `plugins/org/dispatcher.test.ts` over a real `ProviderIssues`: start, refusal, reconcile after reassign and finish, withdrawal closes sessions, lend requeues |
| 4 | `plugins/issues/host.test.ts`: loads without `org`; provider release requeues and keeps assignees; app run with `org` disabled |
| 5, 6, 10 | `plugins/issues/make-issues.test.ts`; `plugins/issues/issues-page.test.tsx` |
| 8 | `plugins/org/org.test.ts`, including `IssuesNotLoaded`; `plugins/org/agents-page.test.tsx` shows the `IssuesNotLoaded` text |
| 3 (hires) | `plugins/org/org.test.ts`: `watchHireChanges` emits after hire, dismiss and rename; `plugins/org/host.test.ts`: a hire made after registration is accepted by `Issues.assignIssue` |
| 9 | `plugins/issues/issue-tools.test.ts` (moved) |
| 7 (page) | `plugins/issues/issues-page.test.tsx`: a `triage` issue shows its `refusal` unchanged |
| providers | `plugins/issues/host.test.ts`: `registerProvider` returns after the first emission; a second provider with the same id fails with `AssigneeProviderTaken` |
| handover failure | `plugins/org/host.test.ts`: a failed `handOverWork` registers no provider and starts no assistant |
| reconcile | `plugins/org/dispatcher.test.ts`: an issue in `failed` is retried after it is reassigned; a `todo` issue present at lend starts without a further change |
| exports | `src/host/plugins/plugin-exports.test.ts` with the two new modules |

## Refinement Record

### Round 1

**Applied**
- C1 *Correctness* (blocker) — event import was not idempotent (`org_events.seq` autoincrement); `issue_events.imported_seq UNIQUE`, `ImportedEvent.seq`.
- C2 *Correctness* (blocker) — handover, provider and dispatcher had no order; one `whenProvided` runs them in order.
- C3 *Correctness* — drops must run child-first in one transaction under `foreign_keys = ON`.
- C4 *Correctness* — `Plan: <title>` can exceed 120 characters; `prefixedTitle` moves to `org`.
- C5 *Correctness* — refusal text can exceed its cap and `missing` is a JSON array; `refusalOf` truncates, handover decodes first.
- C6 *Correctness* — route `plan` takes no assignee (`routing-tools.ts:157-160`); criterion 2 fixed.
- C7 *Correctness* — two calls lose today's atomicity and a retry gets a new id (`routing-tools.ts:218`); `createObjective(input, firstIssues)` in one transaction. The dialog passes `[]`, so decision 4 holds.
- C8 *Correctness* (blocker) — unload and reload of `issues` left sessions running and issues stuck started; `lendIssues` requeues first, withdrawal closes sessions, provider release requeues.
- C9 *Correctness* — `release` also cleared `failed` (`dispatcher.ts:593-597`); the pass reconciles `failed`.
- C10 *Correctness* — assistant and routing tools need `Issues`; `runAssistant` under `[AgentBackendKey, IssuesKey]`, `objectives_read` and notices updated.
- C11 *Correctness* — edit list missed files; `tool-input.ts` copied; exports listed in both tsconfigs (`plugin-exports.test.ts:103`).
- C12 *Correctness* — `RelativeTime` takes ISO strings and `StatusMedia` only `fill`; mappings stated.
- C13 *Correctness* — citations corrected.
- P1 *Project rules* — `registerProvider` departs from ADR-0072's `Effect<void, E, Scope>`; ADR amendment added.
- P2 *Project rules* — `NewWorkIssue` schema for the call.
- P3 *Project rules* — JSDoc and schema-derived types stated.
- P4 *Project rules* — Logging section added.
- P5 *Project rules* — `calls.ts` not exported.
- P6 *Project rules* — imports from `@dia-plugin/issues/domain` and `HireNotFound` placement stated.
- P7 *Project rules* — test rows added.
- D1 *Define Errors Out of Existence* — `issueTools(issueId, assigneeId)` derives the objective.
- D2 *Information Hiding* — imported events stored as text and never read.
- D3 *Minimize Complexity* — `ProviderIssues.watchChanges` removed; the dispatcher uses `Issues.watchChanges`.
- D4 *Deep Modules* — transitions documented in one JSDoc.
- D5 *Strategic Programming* — `WatchOrgLive` carries only `assistantMissing`.
- D6 *Names* — `ListedAssignee`; "<provider id> not loaded"; `watchChanges` emits on provider changes.

**Rejected**
- none

### Round 2

**Applied** (each claim checked: `org.ts:130-131,430` publishes only job title changes; `calls.ts:111`; `dispatcher.ts:211` `failed` is a `Set`; `glossary.md:12`; no `dia-plugin` in `tsconfig.base.json` or `electron.vite.config.ts`)
- R2-1 *Correctness* (blocker) — `Org` has no hire-change notification, so a new hire would never be a valid assignee; `watchHireChanges` added and merged into `assignees`.
- R2-2 *Correctness* — `registerProvider` returns after the first `assignees` emission is stored.
- R2-3 *Correctness* (blocker) — `IssuesNotLoaded` was undefined and absent from the `Dismiss` Rpc union; defined in `org/domain.ts`, added to the union and the agents page.
- R2-4 *Correctness* — `firstIssues` required an `id` no caller passes; `FirstIssue` has no id.
- R2-5 *Define Errors Out of Existence* — `createIssue` accepted `planning`; it takes `NewWorkIssue`, and only `FirstIssue` allows `planning`.
- R2-6 *Project rules* (derive types from schema) — `AssigneeGroup` moved to `domain.ts` and reused by `providers` and `IssuesView`.
- R2-7 *Correctness* — alias locations corrected.
- R2-8 *Correctness* — `scheduler.ts` and the full list of moved imports added.
- R2-9 *Correctness* — service exports and `objectives` assignee columns stated.
- R2-10 *Consistency* — refusal assumption names `Refusal`.
- R2-11 *Correctness* — `in_review` exception stated.
- R2-12 *Correctness* — criterion 4 needs one handover run first; assumption added.
- R2-13 *Project rules* (JSDoc) — JSDoc on `Issues`, `IssuesSnapshot`, `ImportedEvent`, `ImportedWork`; `importWork` JSDoc no longer states storage detail.
- R2-14 *Names*, *ADRs* — `openIssues` renamed `countOpenIssues`; ADR note records the ADR-0071 notice link change.
- R2-15 *Correctness* — `failed` becomes a `Map`; a failed handover is stated.
- R2-16 *Correctness* — non-atomic dismiss check recorded as an assumption.

**Rejected**
- none

### Round 3

**Applied** (checked: `org.ts:126` `makeOrg(openIssuesOf)`; `service.ts:56` `holdDefinitions`; `dispatcher.ts:561` `yield* signal`; `assistant.ts:339` first snapshot; `handover.ts:73` `handoverPending` checks one table; `domain.ts:538` `PermissionNotPending`; `api.ts:76-87` nested `whenProvided`)
- R3-1 *Correctness* (major) — the assistant could start before the import and send spurious notices; it runs as step 4 of the `IssuesKey` setup.
- R3-2 *Correctness*, *Information Hiding* (major) — how `dismiss` reaches `ProviderIssues` was unspecified; `Org.holdIssues` follows `holdDefinitions`.
- R3-3 *Correctness* (major) — no initial pass; `lendIssues` signals one.
- R3-4 — stale `kind` wording.
- R3-5 *Names* — `workHandoverPending`.
- R3-6 *Correctness* — branded `ProviderId`; `ORG_PROVIDER`.
- R3-7 *Correctness* — `assignees` built with `Stream.unwrap`; a stream that ends early is defined.
- R3-8 *Correctness* — page text "not ready"; failure wording no longer claims log level.
- R3-9 *Project rules* — glossary Scope and statuses pointer; `PermissionNotPending` kept.
- R3-10 *Interface Segregation* — `lendIssues` takes `Pick<Issues, 'watchChanges'>`; `Issues` JSDoc carries member semantics.
- R3-11 — test rows added.
- R3-12 — assumption added, reworded without a timing claim the code does not guarantee.

**Rejected**
- none
