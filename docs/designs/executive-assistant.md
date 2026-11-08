# Executive assistant

Issue #172. A new ADR-0071 amends ADR-0053, ADR-0064 and ADR-0069. Builds on ADR-0070 (attached sessions).

## Scope

The org plugin runs one Executive assistant session. The user types a request in it; the assistant creates an objective routed `direct` (one `work` issue for a named hired agent) or `plan` (a planning issue), passes follow-ups to running agents, stops objectives, and is told when an objective it created needs the user or completes.

Out of scope: more than one assistant session, closing it, OS notifications (#217), notices for permission requests (the hired agent's attached pane already shows them).

## Success criteria

1. The Job titles page lists `Executive assistant` as built-in. `Org.hire` refuses it. It can be disabled, copied and edited; a copy is hireable.
2. On start the `Assistant` rail group shows one row; after a restart the row shows the earlier transcript.
3. `objective_create` with route `direct` and assignee Ada creates one objective with one `work` issue in `todo` assigned to Ada and no planning issue; the dispatcher starts it.
4. `objective_create` with route `plan` creates one objective with one unassigned planning issue.
5. `objectives_read` returns open objectives, so the assistant can see a matching one before creating another.
6. `objective_attach` sends the message as a `queue` message to each running session of the objective.
7. While the app runs, when an issue of an objective the assistant created reaches `in_review`, a notice with an Open link appears in the assistant pane, and the next message the model receives starts with that notice's text. Open shows that objective on the org page.
8. **Start over** replaces the transcript with an empty one; the row stays.
9. The assistant session never counts toward the overall cap: it is never opened through the dispatcher.

## Modules

| Module | Owns | New / changed |
| --- | --- | --- |
| `plugins/org/built-in-job-titles.ts`, `domain.ts`, `migrations.ts` | The eighth built-in job title; migration 8 | changed |
| `plugins/org/org.ts`, `service.ts`, `calls.ts`, `hire-dialog.tsx` | Refusing to hire the Executive assistant; hiding it in the hire dialog; `jobTitleChanges` | changed |
| `plugins/org/work.ts` (`Work`), `objective-dialog.tsx` | Objectives created with a route; stopping an objective | changed |
| `plugins/org/routing-tools.ts` | The four routing tools | new |
| `plugins/org/assistant.ts` (`Assistant`) | The one assistant session, the objectives it created, its notices | new |
| `plugins/org/dispatcher.ts` (`Dispatcher`) | Sending a message to one issue's live session | changed |
| `plugins/org/host.ts` | Wiring the above inside `ctx.whenProvided([AgentBackendKey])` | changed |
| `plugins/org/renderer.ts`, `org-page.tsx` | Showing the objective a page target names | changed |
| `src/shared/domain/attached-session.ts`, `src/host/plugins/host-plugin-context.ts`, `src/host/services/attached-sessions.ts` | A project-less attached session; resetting one | changed |
| `src/shared/ipc/contract.ts`, `rpc.ts`, `src/preload/host-api.ts`, `src/host/rpc-handlers.ts` | `ResetAttachedSession` | changed |
| `src/host/session/protocol.ts`, `src/shared/ipc/contract.ts` (`PaneSessionNotice`), `src/shared/domain/pane-chat.ts` | A notice link | changed |
| `src/renderer/src/lib/view.ts`, `actions.ts`, `plugins/layout/slots.ts`, `plugins/layout/layout.tsx` | A page target | changed |
| `plugins/agent-overview/overview.ts`, `agent-overview.tsx`, `agent-row.tsx`, `project-group.tsx` | The `Assistant` group and its row | changed |
| `plugins/chat/` | Rendering a notice link | changed |
| `docs/glossary.md`, `DESIGN.md`, `docs/adr/` | Routes, the Assistant group, ADR-0071 and amendment notes | changed |

## Data model

### Job title

```ts
// domain.ts
export const BuiltInJobTitle = Schema.Literals([
  'product-manager', 'software-engineer', 'quality-engineer', 'business-analyst',
  'ui-ux', 'team-lead', 'technical-lead', 'executive-assistant'
])
```

Migration 3's seed loop (`migrations.ts:90`) and its name-clash check for copies (`migrations.ts:62`) use a frozen list of the seven ADR-0064 seeds, not `BUILT_IN_JOB_TITLES`, so a fresh database runs the same steps as an upgraded one. Migration `8_executive_assistant`:

1. Rebuilds `job_titles`, with every column through migration 7 (including `model` and `thinking_level`, added by migration 4), and the eight-literal `CHECK` on `built_in`: `PRAGMA defer_foreign_keys = ON`, copy `job_titles` to a temp table, drop `job_titles`, recreate it, reinsert the rows, drop the temp table. `PRAGMA foreign_keys = ON` is set before the migrator runs (`database.ts:49`) and cannot be turned off inside its transaction; with deferred checks, the `hired_agents` references the drop breaks are satisfied again before commit. Checked on SQLite 3.50.4: after the rebuild `PRAGMA foreign_key_check` is empty and no hire or assignee changes.
2. Inserts the seed: id `6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0018`, name `Executive assistant`, `permissions` `{ allow: [mcp__dia__objectives_read, mcp__dia__objective_create, mcp__dia__objective_attach, mcp__dia__objective_stop], ask: [], deny: [] }`.
3. Creates `assistant_session` and `assistant_objectives` (below).

Every session sees the four routing tools, because the dia MCP server serves the same tools to all. A hired agent's job title has no allow rule for them: in `auto` the classifier decides, and in `default` the call raises a permission request in the agent's attached pane (ADR-0070). Its sessions run in `dontAsk`, as ADR-0054 already states for the router (`0054-…md:40`): every tool outside the allow list is denied without a request. A copy (`builtIn: null`) is an ordinary job title. The doc comments that say "seven" are updated.

### Routes

```ts
// domain.ts
/** Plan the objective: its planning issue goes to `assignee`, or waits for the user when null. */
export const PlanRoute = Schema.TaggedStruct('PlanRoute', { assignee: Schema.NullOr(HireId) })
/** One piece of work: a single `work` issue for `assignee`, with no planning issue. */
export const DirectRoute = Schema.TaggedStruct('DirectRoute', { assignee: HireId })
export const ObjectiveRoute = Schema.Union([PlanRoute, DirectRoute])

export const NewObjective = Schema.Struct({
  id: ObjectiveId, projectId: ProjectId, title: WorkTitle, description: Schema.String,
  priority: ObjectivePriority, route: ObjectiveRoute
})
```

`assignee` moves from `NewObjective` into the route; the objective form (`objective-dialog.tsx:97`) sends `PlanRoute`. The `CreateObjective` payload (`calls.ts:158`) changes shape with it (whether the org plugin's calls carry their own version is unverified). Tests that build `NewObjective` (`work.test.ts`, `dispatcher.test.ts`, `issue-tools.test.ts`) pass a `PlanRoute`. A `direct` route with no assignee cannot be built.

| Route | `Work.createObjective` creates | `Objective.assignee` |
| --- | --- | --- |
| `PlanRoute` | the objective and its planning issue `Plan: <title>` in `todo`, assigned to `assignee` (ADR-0069, unchanged) | `assignee` |
| `DirectRoute` | the objective and one `work` issue titled `<title>` in `todo`, assigned to `assignee`, with the objective's description; no planning issue | `assignee` |

### Stopping

`Work.stopObjective(objectiveId): Effect<ReadonlyArray<Issue>, ObjectiveNotFound>` sets every issue of the objective that is not `done` or `canceled` to `canceled` and returns them. An objective with no such issue returns `[]`. The objective is then `completed` by ADR-0069's rule.

### Assistant tables

```sql
CREATE TABLE assistant_session (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pane_id    TEXT NOT NULL,
  session_id TEXT
);
CREATE TABLE assistant_objectives (
  objective_id TEXT PRIMARY KEY
);
```

`assistant_session` has one row: `pane_id` names the attached pane, `session_id` is the session the next start resumes, or null. `assistant_objectives` lists the objectives the assistant created; `Work` and `Objective` do not know about it.

## Interfaces

### Host: attached sessions

```ts
// src/shared/domain/attached-session.ts — what the renderer receives
export const AttachedSession = Schema.Struct({
  config: PaneConfig,
  projectId: Schema.NullOr(ProjectId),   // null: shown in the Assistant group
  label: Schema.NonEmptyString,
  caption: Schema.String,
  resettable: Schema.Boolean
})

// src/host/plugins/host-plugin-context.ts — what a plugin passes
export interface SessionAttachment {
  readonly display: Omit<AttachedSession, 'resettable'>
  readonly resume: Option.Option<SessionId>
  readonly open: (emit: (message: OutboundMessage) => Effect.Effect<void>) => Effect.Effect<AgentSession, never, Scope.Scope>
  readonly reset: Option.Option<Effect.Effect<void>>
}
```

`AttachedSessions.attach` publishes `{ ...display, resettable: Option.isSome(reset) }` and records the `reset` by pane id, removing it on release; `AttachedSessions` gains `reset(paneId)`, which the RPC handler calls. New RPC `ResetAttachedSession { paneId }` runs the attachment's `reset`, and does nothing for a pane with no `reset`. `window.dia.resetAttachedSession(paneId)` calls it. `PROTOCOL_VERSION` goes from `0.0.27` to `0.0.28`; `PLUGIN_API_VERSION` from `0.0.33` to `0.0.34`.

### Host: notice link

```ts
// src/host/session/protocol.ts
export const NoticeLink = Schema.Struct({
  label: Schema.NonEmptyString, plugin: PluginName, page: Schema.String, target: Schema.String
})
export const SessionNotice = Schema.TaggedStruct('SessionNotice', {
  text: Schema.String, link: Schema.optional(NoticeLink)
})
```

`PaneSessionNotice` and the `notice` `PaneMessage` carry `link`. The chat pane renders it as a link button after the notice text; clicking it calls `actions.openPage({ plugin, id: page, target })`.

### Renderer: page target

`PageKey` gains `target: Schema.optional(Schema.String)`. `Page.component` (`plugins/layout/slots.ts:10`) becomes `ComponentType<{ readonly target: string | undefined }>`, and `layout.tsx` renders `<page.component target={page.key.target} />`; existing pages ignore the prop. The org page shows `ObjectivesView({ objectiveId: target })` whenever `target` changes; an unknown id falls back to the first objective, as `objectives-page.tsx` does today.

### Routing tools

`makeRoutingTools(deps)` returns four `DiaTool`s.

```ts
interface RoutingToolDeps {
  readonly work: Pick<Work, 'snapshot' | 'createObjective' | 'stopObjective'>
  readonly hires: Effect.Effect<ReadonlyArray<{ id: HireId; name: string; jobTitle: string }>>
  readonly projects: Effect.Effect<ReadonlyArray<{ id: ProjectId; name: string }>>
  readonly assistant: Pick<Assistant, 'claim'>
  readonly dispatcher: Pick<Dispatcher, 'message' | 'release'>
}
```

`hires` and `projects` are built in `host.ts` from `Org` and the workspace ref.

| Tool | Input | Result |
| --- | --- | --- |
| `objectives_read` | none | Registered projects (id, name); hired agents (id, name, job title); open objectives with id, project, title, priority, and each issue's title, status and assignee name |
| `objective_create` | `project`, `title`, `request` (the user's words verbatim), `note` (optional, at most 30 words), `priority` (optional, default `normal`), `route` (`direct` or `plan`), `assignee` (hire id) | The new objective's id and its first issue |
| `objective_attach` | `objective`, `message` | `Delivered to <n> running session(s).`; with `n = 0`, `No agent is working on this objective now.` |
| `objective_stop` | `objective` | The titles of the issues it canceled |

`objective_create` decodes its input into one of two shapes before it reaches `Work`: `{ route: 'direct', assignee: HireId }` or `{ route: 'plan' }`. An `assignee` given with `plan` or missing with `direct` fails decoding with a tool error, so neither reaches `Work`. It stores `request` as the description, followed by a blank line and `Routing note: <note>` when a note is given, calls `assistant.claim(objectiveId)`, then `work.createObjective`. `claim` is idempotent, and `assistant_objectives.objective_id` has no foreign key: an id with no objective is ignored when notices are computed, so a failed `createObjective` leaves nothing to clean up. The tool generates a fresh UUID on every call, so an orphan id never matches a later objective.

`objective_attach` filters `work.snapshot`'s issues by objective and a started status, calls `dispatcher.message(issueId, message)` for each, and counts the `true` results.

`objective_stop` calls `work.stopObjective`, then `dispatcher.release(issueId)` for each returned issue, as `FinishIssue` does (`host.ts:178`).

### Dispatcher

```ts
/** Sends `text` as a `queue` message to issue `issueId`'s live session; false when it has none. */
readonly message: (issueId: IssueId, text: string) => Effect.Effect<boolean>
```

### Assistant

```ts
/** The org's one Executive assistant session (ADR-0071). */
export interface Assistant {
  /** Records that the assistant created objective `objectiveId`, so its changes produce notices. */
  readonly claim: (objectiveId: ObjectiveId) => Effect.Effect<void>
  /** Replaces the session with a new one that has an empty transcript. */
  readonly startOver: Effect.Effect<void>
}

/** Builds the assistant inside the plugin's scope; it runs while the built-in job title is enabled. */
export const makeAssistant: (deps: {
  readonly jobTitles: Effect.Effect<ReadonlyArray<JobTitle>>
  readonly jobTitleChanges: Stream.Stream<void>
  readonly work: Pick<Work, 'snapshot' | 'watchChanges'>
  readonly backend: AgentBackend
  readonly tools: ReadonlyArray<DiaTool>
  readonly attach: HostSessions['attach']
  readonly directory: string
}) => Effect.Effect<Assistant, never, Scope.Scope | SqlClient.SqlClient>
```

`host.ts` builds it inside `ctx.whenProvided([AgentBackendKey])`, passing `<ctx.dataDir>/assistant` (created with `recursive: true`) as `directory`.

Session:

- While the built-in Executive assistant job title is enabled, it attaches one session: `projectId: null`, label `Executive assistant`, caption `''`, `reset: Some(startOver)`, cwd `directory`, `permissionMode: 'dontAsk'`, the job title's model (or the first model of `backend.models()` when null), thinking level, description, permissions and MCP servers, resuming `assistant_session.session_id`.
- `open` passes the backend a wrapped `emit`: on `SessionStarted` it writes `assistant_session.session_id`, then forwards every message (as `dispatcher.ts:234` does for issues). The Host's `attachPane` reports no session id itself (`pane-supervisor.ts:964`).
- `Org` gains `jobTitleChanges: Stream<void>`, published after `setJobTitleEnabled` and `editJobTitle` (`deleteJobTitle` refuses a built-in, `org.ts:262`). On each emission the assistant re-reads `jobTitles`: it attaches when the built-in is enabled and nothing is attached, and closes the attachment when it is disabled. An edit to the enabled job title changes nothing in the running session; the next start (app restart or Start over) uses the new settings, so a running turn is never cut off.
- `startOver` clears the pending notice texts, writes a new `pane_id` and a null `session_id` in one statement, then closes the scope and attaches a fresh session inside one uninterruptible region. The old pane's recorded events stay in the event store, like a closed tab's. When the old pane was the open attached session, the renderer's `closeDetached` shows the tab from before it; the user opens the new row.

Notices:

- It keeps the `emit` that `open` receives; with no session open, notices are dropped.
- On each `watchChanges` emission it reads `work.snapshot` and compares it with the previous one for objectives in `assistant_objectives`. It emits a `SessionNotice` with link `{ label: 'Open', plugin: 'org', page: 'org', target: objectiveId }` when an issue enters `triage`, an issue reaches `in_review`, or the objective becomes `completed`. The first snapshot after start is the baseline and produces no notices.
- The session it attaches wraps `sendText`: pending notice texts are prefixed to the next message, one per line, then cleared. Pending texts are held in memory and lost on restart.
- A notice row is live only: the recorder stores no `SessionNotice` (`agent-event-recorder.ts`, `entriesFor` default case), so the row is gone after a restart, a disable and enable, or Start over. Its text still reaches the model with the next message unless the process restarts first.

Example notice: `Ada moved "Fix the typo in the README" to in review.` → `[Open]`.

### Agent overview

`buildOverview` returns the attached sessions with `projectId: null` as a separate `assistant` list. `agent-overview.tsx` renders an `Assistant` group above the project groups when the list is not empty. Its row uses the attached-row rules in `DESIGN.md`; its menu is **Show** and, when `resettable`, **Start over**. The group header has no count and no New action. Visual design: `/impeccable`.

## Errors

| Error | Raised by | When | Reaches |
| --- | --- | --- | --- |
| `JobTitleNotHireable` | `Org.hire`, checked next to `JobTitleDisabled` (`org.ts:288`) | the job title's `builtIn` is `executive-assistant`; it stays enabled so the assistant can run | `Org` service type, `Hire` RPC error (`calls.ts`), the hire dialog |
| `HireNotFound` | `Work.createObjective` | the route's assignee is not hired | tool error text |
| `ProjectNotFound` | `Work.createObjective` | the project is not registered | tool error text |
| `ObjectiveNotFound` | `Work.stopObjective` | the objective id is unknown | tool error text |
| decoding failure | routing tools | invalid input, including `assignee` with `plan` or none with `direct` | tool error text |

## Test plan

| Behaviour | Test |
| --- | --- |
| Criterion 1 | `org.test.ts`: hire refuses the built-in; a copy hires. `migrations.test.ts`: the seed and allow list on a fresh database and on an upgrade from migration 7 |
| Criteria 3, 4 | `work.test.ts`: each route's issues and `Objective.assignee` |
| `stopObjective` | `work.test.ts`: cancels open issues, leaves `done` ones, returns `[]` on a completed objective |
| Criteria 5, 6 | `routing-tools.test.ts`: read output, decoding of both route shapes, attach counts, stop calls `release` |
| `Org.jobTitleChanges` | `org.test.ts`: emits after enable and edit. `assistant.test.ts`: disable closes, enable attaches, an edit leaves the session open |
| Migration 8 upgrade | `migrations.test.ts`: a database with hires and assigned issues keeps every hire and assignee; `foreign_key_check` is empty |
| `Dispatcher.message` | `dispatcher.test.ts`: true with a live session, false without |
| Criterion 7 | `assistant.test.ts`: a notice with its link on `in_review`, none on the baseline, the prefixed next message. `pane.test.tsx`: the link renders and opens the page with its target |
| Criterion 8 | `assistant.test.ts`: start over writes a new pane id and opens without resume. `rpc-handlers.test.ts`: `ResetAttachedSession` runs `reset` |
| Criterion 9 | `assistant.test.ts`: the session is attached directly, never through the dispatcher |
| Assistant group | `overview.test.ts`: a `projectId: null` session lands in `assistant`, not a project group |
| Criterion 2 | app run (`verify-in-app`) |

## Refinement record

| Round | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | C1 migration 8 conflicts with the `CHECK` at `migrations.ts:82` and migration 3's loop over the live seed list | blocker | applied: frozen seven-seed list, table rebuild |
| 1 | C2 `openPage` has no target (`actions.ts:77`) | blocker | applied: `PageKey.target`, page `component` receives it |
| 1 | C3 `ProjectDirectory` cannot list projects | blocker | applied: `projects` effect from the workspace ref |
| 1 | C4 dispatcher does not react to `canceled` | blocker | applied: `objective_stop` calls `release`, as `FinishIssue` does |
| 1 | C5 dispatcher has no objective-to-issue map | major | applied: `message(issueId, text)` |
| 1 | C6 `open` return type | major | applied: `Effect<AgentSession, never, Scope.Scope>` |
| 1 | C7 `watchChanges` is `Stream<void>` | major | applied |
| 1 | C8 emit, backend and model plumbing | major | applied |
| 1 | C9 `dontAsk` cites the wrong ADR | major | rejected: `0054-…md:40` states router sessions start in `dontAsk` |
| 1 | C10 notice persistence unverified | minor | applied: pending texts stated as lost on restart; notice-row replay checked during implementation |
| 1 | C11 versions and wiring | minor | applied |
| 1 | C12 overview files | minor | applied |
| 1 | R1 hire error reaches service, RPC, dialog | major | applied |
| 1 | R2 test plan gaps, docs | minor | applied |
| 1 | R3 JSDoc on the sketch | minor | applied |
| 1 | D1 `fromAssistant` flag on `Work` | major | applied: `assistant_objectives`, owned by `Assistant` |
| 1 | D2 `reset` and `resettable` duplicated | major | applied: Host derives `resettable` |
| 1 | D3 route input and attach errors | major | applied: decoded union, count result |
| 1 | D4 `startOver` ordering | major | applied: one write, then one uninterruptible close-and-attach |
| 1 | D5 wide deps | minor | applied: `Pick` and narrow effects |
| 1 | D6 notice on the assistant's own `plan` creation | minor | applied: dropped |
| 1 | D7 `Objective.assignee` for `direct` | minor | applied: route table |
| 2 | B1 table rebuild under `foreign_keys = ON` | blocker | applied: `defer_foreign_keys`; checked on SQLite 3.50.4 |
| 2 | B2 `jobTitles` is one-shot | blocker | applied: `Org.jobTitleChanges` |
| 2 | B3 `Page.component` takes no props | blocker | applied: `target` prop through `slots.ts` and `layout.tsx` |
| 2 | M1 session id path | major | applied: wrapped `emit` on `SessionStarted` |
| 2 | M2 notices not recorded | major | applied: notice rows are live only; criterion 7 says "while the app runs" |
| 2 | M3 `claim` after create leaves duplicates on retry | major | applied: claim first, no foreign key |
| 2 | m1 hire check placement | minor | applied |
| 2 | m2 hired agents see routing tools | minor | applied: stated per mode |
| 2 | m3 Start over while shown | minor | applied: `closeDetached` shows the earlier tab |
| 3 | 1 re-attach on edit cuts off a running turn and moves the user off the pane | major | applied: edits take effect at the next start |
| 3 | 2 `createObjective` callers and tests | major | applied |
| 3 | 3 migration 8 columns and migration 3's name check | minor | applied |
| 3 | 4 delete cannot touch a built-in | minor | applied |
| 3 | 5 `AttachedSessions.reset` plumbing | minor | applied |
| 3 | 6 Start over keeps pending notices | minor | applied: cleared |
