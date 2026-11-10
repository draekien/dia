# Org onboarding

Scope: module (changes in the `org` plugin: a team staffing call on `Org`, the assistant's pane published by `assistant.ts`, two fields on `OrgLive`, team presets, a Staff the org dialog, an onboarding strip and a team work box on the Dashboard, and the job title description in the Hire dialog).

Decisions confirmed by the user on 2026-11-11:

1. Onboarding has two stages: first staff the org (create a team), then get the team working.
2. Staffing starts from a team preset whose counts per job title the user can adjust.
3. The Dashboard's "What should the team work on?" box sends its text to the Executive assistant (ADR-0071), which routes it.
4. The one-agent Hire dialog stays for one-off hires, from Hired agents and from a job title.

Evidence: a first-run walk of the packaged app (scratch profile, 2026-11-11). The Dashboard says `No agents are hired. Hire one to start building the org.` with no mention of a project; the Hire dialog's job title select lists names only; after `Hire` the app shows the agent's detail with no next step; the Dashboard then reads `Nothing needs attention.` while the hire is idle; giving work happens on the Issues page or in the Executive assistant chat, and nothing on the Org page links to either. Paperclip's `ui/src/components/OnboardingWizard.tsx` (step "Give it a heartbeat", line 2343) hires the lead agent and gives it its first task in the same step.

## Success criteria

1. With no project, no hire and no work, the Dashboard shows the strip `Add a project`, `Staff the org`, `Get the team working` with `Add a project` current and an `Add project` button that calls `actions.registerProject()` and shows a refusal the way `src/renderer/src/components/agent-overview.tsx:437` does.
2. With a project and no hire, `Staff the org` is current and its `Staff the org…` button opens the Staff the org dialog.
3. The Staff the org dialog offers the presets whose job titles are all enabled; choosing `Feature team` sets the `Lead` select to Team lead and the member counts to Software engineer 2 and Quality engineer 1. `Hire 4 agents` hires 4 agents in one transaction: the Team lead reports to the user, the other 3 report to the Team lead. With `Lead` set to `None`, every member reports to the user. With `Lead` `None` and every count 0, the button reads `Hire` and is disabled.
4. If any hire in the call fails (`JobTitleNotFound`, `JobTitleDisabled` or `JobTitleNotHireable`), the transaction rolls back, no agent is hired, and the dialog shows the same text the Hire dialog shows for that error.
5. With a hire and no open issue assigned to any hire, `Get the team working` is current and the Dashboard shows `What should the team work on?`; `Send` sends the text with `paneSendAtom(paneId)` as `{ text, mode: 'queue' }` and shows that session with `actions.selectAttached(paneId)`. While the Executive assistant is not attached, `Send` is disabled and the box says `The Executive assistant is not running.`
6. Once any hire has an open issue, the strip and the team work box are gone and the Dashboard shows `Needs attention` as today.
7. Each `SelectItem` of the Hire dialog's job title select shows the job title name and, under it, the first non-empty line of its job description, clamped to one line with an ellipsis. A job description with no non-empty line shows the name only. The closed trigger (`SelectValue`) shows the name only.

## Interface

### Host (`plugins/org/calls.ts`, `plugins/org/service.ts`)

```ts
/** A team to hire in one call: an optional lead, and the members. At least one hire. */
export const TeamPlan = Schema.Struct({
  lead: Schema.NullOr(JobTitleId),
  members: Schema.Array(JobTitleId)
}).check(Schema.makeFilter((plan) => plan.lead !== null || plan.members.length > 0, { title: 'at least one hire' }))
export type TeamPlan = typeof TeamPlan.Type

/**
 * Hires `plan` in one transaction: the lead reports to the user and every member reports to the
 * lead, or to the user when there is no lead. Hires are unnamed. Fails, hiring nobody, when any
 * job title is missing, disabled or the Executive assistant.
 */
export const StaffTeam = Rpc.make('StaffTeam', {
  payload: { plan: TeamPlan },
  success: Schema.Array(HiredAgent),
  error: Schema.Union([JobTitleNotFound, JobTitleDisabled, JobTitleNotHireable])
})

// Org service
readonly staffTeam: (plan: TeamPlan) => Effect.Effect<ReadonlyArray<HiredAgent>, JobTitleNotFound | JobTitleDisabled | JobTitleNotHireable>

/**
 * The org's live state the Dashboard shows: `assistantMissing` as today; `assistantPaneId`, the
 * pane of the Executive assistant session while it is attached; `teamHasWork`, whether any hire
 * has an open issue.
 */
export const OrgLive = Schema.Struct({
  assistantMissing: Schema.Array(MissingReference),
  assistantPaneId: Schema.NullOr(PaneId),
  teamHasWork: Schema.Boolean
})
```

### Renderer

```ts
// plugins/org/team-presets.ts
/** A built-in team shape: a label, an optional lead and members, by built-in job title kind. */
export interface TeamPreset { readonly id: string; readonly label: string; readonly lead: BuiltInJobTitle | null; readonly members: ReadonlyArray<BuiltInJobTitle> }
/** The built-in team shapes the Staff the org dialog offers, in display order. */
export const TEAM_PRESETS: ReadonlyArray<TeamPreset>
/** The preset as a TeamPlan over `jobTitles`: each built-in kind maps to the id of the enabled job title with that `builtIn`. None when any kind has no enabled job title. */
export const planOf: (preset: TeamPreset, jobTitles: ReadonlyArray<JobTitle>) => Option<TeamPlan>

// plugins/org/staff-dialog.tsx
/** The Staff the org dialog: a preset, a `Lead` job title or `None`, member counts per enabled hireable job title, and `Hire N agents`, which sends `StaffTeam`; `onStaffed` gets the hires once `snapshot` has been re-read. */
export function StaffDialog(props: { snapshot: OrgSnapshot; call: OrgCall; onStaffed: (hires: ReadonlyArray<HiredAgent>) => void; onClose: () => void })

// plugins/org/onboarding.tsx
/** The onboarding step the Dashboard marks current. */
export type OnboardingStage = 'add-project' | 'staff' | 'get-working'
/** The current stage, or null once the team has work. */
export const onboardingStage: (projects: number, hires: number, teamHasWork: boolean) => OnboardingStage | null
/** The three onboarding steps with `stage` current, and the current step's action. */
export function OnboardingStrip(props: { stage: OnboardingStage })
/** `What should the team work on?`: sends its text to the Executive assistant at `assistantPaneId` and shows that session; disabled while `assistantPaneId` is null. */
export function TeamWorkBox(props: { snapshot: OrgSnapshot; assistantPaneId: PaneId | null })
```

`OrgScreen` gains `openStaff: () => void`, opened from the strip's `Staff the org…` button.

`onboardingStage(projects, hires, teamHasWork)`, where `projects` is `useWorkspace()`'s project count:

| projects | hires | teamHasWork | stage |
| --- | --- | --- | --- |
| 0 | any | any | `add-project` |
| > 0 | 0 | any | `staff` |
| > 0 | > 0 | false | `get-working` |
| > 0 | > 0 | true | null |

Dashboard layout: while the stage is not null, the strip renders above the stats, and the team work box renders under the strip when the stage is `get-working`. The `No agents are hired` row in `Needs attention` is removed, because the strip's `Staff the org…` button replaces it; `NoHires` on the Org chart is unchanged. The assistant-missing row and `Nothing needs attention.` are unchanged.

## Key Data Structures

- `TeamPlan { lead: JobTitleId | null, members: JobTitleId[] }`, invariant: `lead !== null || members.length > 0`.
- `TeamPreset` values: `feature-team` (lead `team-lead`, members `software-engineer`, `software-engineer`, `quality-engineer`), `solo-engineer` (no lead, member `software-engineer`), `product-team` (lead `product-manager`, members `ui-ux`, `software-engineer`).
- `OrgLive.assistantPaneId: PaneId | null`, `OrgLive.teamHasWork: boolean`.
- Host state in `host.ts`, beside the existing `assistantMissing` ref: `assistantPane: SubscriptionRef<PaneId | null>` and `teamHasWork: SubscriptionRef<boolean>`. `watchOrgLive` is `Stream.zipLatestAll` over the three refs' `SubscriptionRef.changes` (each emits its current value first), mapped to `OrgLive` and deduplicated with `Stream.changesWith`, because `SubscriptionRef.set` emits equal values.

## Internal Decomposition

- **Org.staffTeam** (`org.ts`) — owns hiring. `hire` and `staffTeam` share one private step `insertHire(jobTitleId, name, reportsTo, id, hiredAt)`: `findJobTitle`, the disabled and Executive assistant checks, the name check when `name` is not null, the `reportsTo` check, and the INSERT. Both callers mint ids and `hiredAt` first, then run the step inside `hireLock.withPermits(1)` and `transaction`; this moves `hire`'s validation inside its transaction, with no change in behaviour. `staffTeam` runs the step for the lead and then for each member with `reportsTo` the lead's id (`findHire` reads the uncommitted lead row on the same connection), then publishes one hire change and logs once. `staffTeam` turns `HireNameTaken` and `HireNotFound` from `insertHire` into defects with `Effect.catchTags`: unnamed hires under a lead inserted in the same transaction cannot raise them. The `transaction` makes the call all-or-nothing; `hireLock` serialises it against other hires.
- **Assistant** (`assistant.ts`) — gains a `pane: SubscriptionRef<PaneId | null>` dependency, as it already takes `missing`. `attachNow` sets it to `row.pane_id` after `deps.attach` succeeds. `detach` does not touch it. Each branch that leaves the assistant detached sets it to null: `follow`'s none and `Missing` branches, `startOver` when not ready, and the shutdown finalizer. `startOver` when ready replaces the id through `attachNow`, so the ref never reads null while the assistant stays attached.
- **Org live** (`host.ts`) — owns `OrgLive`. `serveLiveCalls` serves `WatchOrgLive` from the three refs whether or not the issues plugin is present. Inside `runIssues`'s `whenProvided([IssuesKey])`, after `registerProvider` returns `runs`, a scoped fiber runs over `Stream.merge(Stream.make(undefined), issues.watchChanges, org.watchHireChanges)` and sets `teamHasWork` with `Effect.exists(hires, (hire) => runs.countOpenIssues(hire.id) > 0)`. An `acquireRelease` sets it back to false when the issues plugin leaves. Without the issues plugin, `teamHasWork` stays false. A dismissed hire needs no case: `dismiss` refuses while the hire has open issues and publishes a hire change.
- **Team presets** (`team-presets.ts`) — owns the built-in team shapes and their resolution to a `TeamPlan` over the current job titles.
- **Staff the org dialog** (`staff-dialog.tsx`) — owns the plan the user edits. `Lead` is a select of `None` or any enabled job title other than the Executive assistant, defaulting to the preset's lead. Member counts are steppers from 0 to 10, one per enabled job title other than the Executive assistant. The dialog builds `TeamPlan` as `{ lead, members }` with each job title id repeated by its count, so every dialog state is a valid plan or disables the button.
- **Hire failure text** (`org-actions.ts`) — `hireFailureText(failure)` moves out of `hire-dialog.tsx`'s switch for the three job title errors, so both dialogs show the same text.
- **Onboarding** (`onboarding.tsx`) — owns the stage rule and the strip and team work box.

## Tests

- `org.test.ts`: `staffTeam` hires the lead with `reportsTo` null and each member with `reportsTo` the lead's id; with no lead every member reports to null; a disabled member job title fails `JobTitleDisabled` and leaves `hiredAgents` unchanged.
- `team-presets.test.ts`: `planOf` maps kinds to ids and returns none when one kind is disabled.
- `assistant.test.ts`: the pane ref holds the attached id after attach, null after the job title is disabled and after `Missing`, and never null across `startOver` while attached.
- Org live: `teamHasWork` is false before any change, true once an open issue is assigned to a hire, and false after the issues plugin leaves.
- `hire-dialog` test: a 500-character job description renders clamped in the option, and the trigger shows the name only.
- `onboarding.test.ts`: `onboardingStage` for each combination of inputs.
- `org-page.test.tsx`: the strip shows each stage; the `No agents are hired` assertion becomes the strip's `Staff the org…`; `Send` calls the pane's send with `mode: 'queue'`. `org-host.fake.tsx` sets `live` with the two new fields.
- Org calls are plugin Rpcs, not members of `DiaRpcs`, so `PROTOCOL_VERSION` does not change.

## Design Rationale

**One `StaffTeam` call, not N `Hire` calls** — a team is hired or not. N calls leave a half-hired team when a later call fails, and the lead's id is needed before the members' `reportsTo` can be set. One transaction makes the half-hired state unrepresentable (Define Errors Out of Existence).

**Presets by built-in kind** — job title ids are the same on every install, but the user can disable a built-in title. Resolving a preset over the current job titles hides a preset whose title is disabled instead of hiring into it.

**Team work goes to the Executive assistant** — the assistant already routes a request to one hire or a planning issue and reads open objectives before creating one. The org renderer sends through `paneSendAtom` (exported by `@dia/renderer-plugin`) to the assistant's pane, the same path as typing in its composer, so pending notices are still prefixed.

**`teamHasWork` from open issues** — the stage ends when the team has work, whoever created it (the assistant, the Issues page, or an agent). The org host already holds `countOpenIssues`.

## Rejected Alternatives

**A modal first-run wizard (Paperclip)** — blocks the app and repeats Add project, which the sidebar and empty content area already offer.

**Counts per job title with no presets** — the user chose presets.

**A New objective button that opens the Issues page** — leaves the Org page, and the org renderer cannot import the issues renderer (`docs/designs/issues-plugin.md`).

## Refinement Record

Round 1 (sonnet):

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | blocker | `assistantPaneId` and `teamHasWork` cannot be built in `serveLiveCalls`: the pane id is private to `assistant.ts`, and the issues service is only in scope in `runIssues` | Applied: the assistant publishes its pane to a host ref; `runIssues` maintains a `teamHasWork` ref. Rejected the proposed renderer lookup by `label === 'Executive assistant'`: it ties the renderer to a display string |
| 2 | major | `TeamPreset` is a hand-declared interface; `OnboardingStage` should be `Schema.Literals` | Rejected: CLAUDE.md forbids an interface beside a parallel schema; neither type is decoded or has a schema |
| 3 | major | No test list; no statement on `PROTOCOL_VERSION` | Applied: Tests section; org calls are not in `DiaRpcs` (`src/shared/ipc/rpc.ts:149`) |
| 4 | major | `staffTeam` would duplicate `hire`'s validation; atomicity source unstated | Applied: shared private step; `transaction` gives atomicity |
| 5 | minor | Criterion 4 names no errors | Applied |
| 6 | minor | `registerProject` refusals unhandled | Applied to criterion 1 |
| 7 | minor | `'done'` stage excluded by `OnboardingStrip`'s prop type; kind-to-id mapping unclear | Applied: `onboardingStage` returns null when done; `planOf` doc states the mapping. Glossary has no staffing term, so `Staff the org` stays UI copy |

Round 2 (sonnet):

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | major | `countOpenIssues` is on `ProviderIssues` (`runs`), not `Issues`; `teamHasWork` had no initial value and no reset | Applied: uses `runs`, a leading emission, and `acquireRelease` reset |
| 2 | major | Setting the pane ref in `detach` makes it null for a moment on `startOver` | Applied: only detached-end branches set null |
| 3 | major | Combining refs unspecified; duplicate emissions | Applied: `Stream.zipLatestAll` plus `changesWith` (`node_modules/effect/src/Stream.ts:5838`) |
| 4 | major | `hire` validates outside its transaction and mints ids before the lock; the shared step's inputs were unstated | Applied: `insertHire` signature and placement |
| 5 | major | Long job descriptions would overflow the select | Applied: one-line clamp; trigger shows name only |
| 6 | minor | New exports in the interface lack JSDoc | Applied |
| 7 | minor | Tests omit the pane ref and `teamHasWork` | Applied |

Round 3 (sonnet):

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | blocker | `TeamPlan`'s single lead slot cannot express a lead count of 0 or 2, and `The team reports to` was undefined | Applied: a `Lead` select (job title or `None`) plus member steppers; `The team reports to` removed, because members report to the lead or, with no lead, to the user |
| 2 | major | `insertHire`'s `HireNameTaken | HireNotFound` widens `staffTeam`'s error type | Applied: `Effect.catchTags` to defects |
| 3 | major | Dashboard layout and the stage table were unspecified; the `No agents are hired` row duplicates the strip | Applied: stage table, layout, row removed |
| 4 | minor | The dialog must not offer the Executive assistant | Applied |
| 5 | minor | The Hire dialog's error text is private | Applied: `hireFailureText` in `org-actions.ts` |

Stopping: the round budget (3, effort medium) is spent. Every finding is applied or rejected; none escalated.
