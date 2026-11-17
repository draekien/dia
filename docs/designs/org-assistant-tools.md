# The Executive assistant's org tools

Scope: a module of `plugins/dia-org` (`org-tools.ts`), its registration in `host.ts`, the Executive assistant's allow list and job description in `built-in-job-titles.ts`, and a one-time grant of `org_read` to an edited Executive assistant. Issue #293.

Eleven dia tools let the Executive assistant read and change the org. Each calls one `Org` method (`plugins/dia-org/service.ts`). Calls that change the Executive assistant, or give a job title permission rules or the bypass opt-in, wait for the user's approval through `Tools.requestApproval` (ADR-0085).

## Success criteria

1. An Assistant run (scope labels include `ASSISTANT_LABEL`) lists all eleven tools; a hired agent's run lists none of them.
2. `hire` adds the hire to `Org.hiredAgents`, and so to the org page; `job_title_create` adds the job title to `Org.jobTitles`, and so to the Job titles page.
3. `job_title_edit` that sets the Builder job title's `permissions` to non-empty rules calls `requestApproval` in every permission mode, including `bypassPermissions`. `'declined'` leaves the job title unchanged and returns an error result; `'approved'` applies the edit.
4. `job_title_edit` of the Executive assistant's `jobDescription` calls `requestApproval`.
5. `org_read` runs without a permission prompt in an org whose Executive assistant was never edited, and in one whose Executive assistant has an override stored before this change; when the job-title handover imports that override, from the launch after the handover.
6. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.

## Interface

`plugins/dia-org/org-tools.ts`:

```ts
/** What the org tools read and change, and how they ask the user to approve a call. */
export interface OrgToolDeps {
  readonly org: Pick<
    Org,
    | 'jobTitles' | 'hiredAgents' | 'hire' | 'staffTeam' | 'renameHire' | 'setReportsTo' | 'dismiss'
    | 'createJobTitle' | 'editJobTitle' | 'copyJobTitle' | 'setJobTitleEnabled' | 'deleteJobTitle'
  >
  readonly requestApproval: Tools['requestApproval']
}

/**
 * The Executive assistant's org tools (#293): `org_read`, `hire`, `staff_team`, `hire_rename`,
 * `hire_set_reports_to`, `hire_dismiss`, `job_title_create`, `job_title_edit`, `job_title_copy`,
 * `job_title_set_enabled` and `job_title_delete`. An `Org` refusal
 * returns its reason with `isError` set and changes nothing. A call that changes the Executive
 * assistant job title, or that sets a job title's `permissions` to non-empty rules or its
 * `bypassOptIn` to true, first asks the user through `requestApproval`; a decline returns an error
 * result and changes nothing. Register them with `dia-tools` for the Executive assistant's run scope.
 */
export const makeOrgTools = (deps: OrgToolDeps): ReadonlyArray<DiaTool>
```

Tool inputs (each a `Schema.Struct`; `org-tools.ts` annotates each field with a `description`). Ids are the ones `org_read` returns. `name` in `hire` and `hire_rename` is the hire's stored name, not its display name.

| Tool | Input | `Org` call |
| --- | --- | --- |
| `org_read` | `{}` | `jobTitles`, `hiredAgents` |
| `hire` | `jobTitleId: JobTitleId`, `name?: AgentName`, `reportsTo?: HireId` | `hire(jobTitleId, name ?? null, reportsTo ?? null)` |
| `staff_team` | `TeamPlan`: `lead: JobTitleId \| null`, `members: Array<JobTitleId>` | `staffTeam(plan)`; `TeamPlan`'s check fails a plan with no lead and no members at input decoding, so it never reaches `run`. The JSON Schema does not carry that check, so the tool description says "at least one of lead or members" |
| `hire_rename` | `hireId: HireId`, `name: AgentName \| null` | `renameHire(hireId, name)`; `null` clears the name, an omitted field fails decoding |
| `hire_set_reports_to` | `hireId: HireId`, `reportsTo: HireId \| null` | `setReportsTo(hireId, reportsTo)`; `null` reports to the user, an omitted field fails decoding |
| `hire_dismiss` | `hireId: HireId` | `dismiss(hireId)` |
| `job_title_create` | `name: JobTitleName`, `jobDescription: string`, optional `skills`, `permissions`, `mcpServers`, `bypassOptIn`, `model`, `thinkingLevel` | `createJobTitle(fields)` with the "New job title" editor's defaults for absent fields: `[]`, empty rules, `[]`, `false`, `null`, `'medium'` |
| `job_title_edit` | `Schema.Struct({ jobTitleId: JobTitleId, ...JobTitleEdit.fields })` | `editJobTitle(jobTitleId, edit)`, with `edit` the input less `jobTitleId` (`Struct.omit`) |
| `job_title_copy` | `jobTitleId: JobTitleId`, `name: JobTitleName` | `copyJobTitle(jobTitleId, name)` |
| `job_title_set_enabled` | `jobTitleId: JobTitleId`, `enabled: boolean` | `setJobTitleEnabled(jobTitleId, enabled)` |
| `job_title_delete` | `jobTitleId: JobTitleId` | `deleteJobTitle(jobTitleId)` |

`org_read` returns JSON: `{ jobTitles: JobTitle[], hiredAgents: { id, name, displayName, jobTitleId, jobTitle, reportsTo }[] }`, where `name` is the hire's stored name (or `null`), `displayName` the name the org shows (`agentName`), and `jobTitle` its job title's name. Every other tool returns one sentence naming what changed, with the ids of new records (`Hired Ada (Engineer), id …`).

### Approval

| Call | Asks when |
| --- | --- |
| `job_title_create` | `permissions` has a rule in `allow`, `ask` or `deny`, or `bypassOptIn` is true |
| `job_title_edit` | the target is the Executive assistant (`builtIn === 'executive-assistant'`), or `edit.permissions` is present with a rule, or `edit.bypassOptIn` is true |
| `job_title_set_enabled` | the target is the Executive assistant |

The request is `{ title, before, after }`:

- `title`: `Create job title "<name>"`, `Edit job title "<name>"`, `Enable job title "<name>"` or `Disable job title "<name>"`.
- `before` and `after`: the job title's definition fields (every `JobTitleFields` field, plus `enabled` for `job_title_set_enabled`) as indented JSON; `before` is empty for a create. `after` is `before` with the change applied.

An edit that sets `permissions` to empty rules does not ask, as the issue states.

The target is read from `jobTitles` before asking; a missing target returns the `JobTitleNotFound` refusal without asking. `after` is computed from `before` when the request is made; the applied result can differ (a name taken since), and the returned text reports the actual outcome.

### Refusals

Each `Org` error becomes one sentence, for example:

| Error | Text |
| --- | --- |
| `JobTitleNotFound` | `No job title has id "<id>". Call org_read for the current ids.` |
| `JobTitleNameTaken` | `A job title named "<name>" already exists.` |
| `JobTitleHasHires` | `The job title has <n> hired agents; dismiss them first.` |
| `HireHasOpenIssues` | `The agent has <n> open issues; finish or cancel them first.` |
| `HireNameTaken`, `HireNotFound`, `ReportsToCycle`, `JobTitleDisabled`, `JobTitleNotHireable`, `BuiltInJobTitleRenamed`, `BuiltInJobTitleDeleted`, `IssuesNotLoaded`, `JobTitlesNotLoaded` | one sentence each, naming the reason |

A defect returns `The <tool> call failed.` with `isError`, as `routing-tools.ts` does.

### Logging

Each call logs `Org tool called` (`tool`) at INFO, then `Org tool call succeeded` (`tool`; the result text names the changed ids), `Org tool refused the call` (`tool`, `reason`: the error tag) at INFO, `Org tool approval answered` (`title`, `answer`) and `Org tool call declined by the user` at INFO, or `Org tool failed` with the cause at ERROR.

### `plugins/dia-org/built-in-job-titles.ts`

```ts
/** The dia tool the Executive assistant reads the org with (#293), as a permission rule name. */
export const ORG_READ_TOOL = 'mcp__dia__org_read'
```

`EXECUTIVE_ASSISTANT.allow` becomes `[...ROUTING_TOOLS, ORG_READ_TOOL]`. Its JSDoc says "as `8_executive_assistant` inserts it in a new database" and drops "its session runs in `dontAsk`, so every other tool is denied", which `assistant.ts` contradicts (its run takes the mode `runSettings` gives), and states that its other org tools go through the session's permission rules. `BUILT_IN_DEFINITIONS`' JSDoc names the allow list as `ROUTING_TOOLS` plus `ORG_READ_TOOL`.

The job description's first paragraph says it also changes the org when the user asks, and gains a section:

```
## How to change the org
- Call org_read before any other org tool, and use the ids it returns.
- Change the org only as the user asks: hire, rename, dismiss and change reporting lines and job titles.
- A change to your own job title, or one that gives a job title permission rules or the bypass opt-in, waits for the user to approve it in dia's window. If they decline, tell them nothing changed.
- If a call is refused, tell the user the reason it gives.
```

### `plugins/dia-org/migrations.ts`

`13_org_read_grant` creates `org_read_grant (id INTEGER PRIMARY KEY CHECK (id = 1))` with one row: the grant below is pending. The `orgMigrations` JSDoc names it.

### `plugins/dia-org/handover.ts`

```ts
/**
 * Adds `ORG_READ_TOOL` to the allow list of the Executive assistant's override in `definitions`,
 * once per org database. Does nothing while job titles wait to be
 * handed over, so an override the handover imports is granted on a later launch. Call it after
 * the built-in definitions are registered.
 */
export const grantOrgRead: (
  definitions: AgentDefinitionRegistry
) => Effect.Effect<void, never, SqlClient.SqlClient>
```

It runs when `org_read_grant` has its row and `handoverPending` is false. It reads `definitions.list`; if the Executive assistant's entry has `edited: true` and its allow list lacks `ORG_READ_TOOL`, it calls `definitions.edit(id, { permissions: { ...permissions, allow: [...allow, ORG_READ_TOOL] } })` and logs `Granted org_read to the edited Executive assistant`. Then it deletes the row. The grant changes only `permissions`: an edited job description is the user's and is not rewritten, so `org_read`'s description and each changing tool's description state "call org_read first and use the ids it returns" themselves. An entry that is missing (another plugin holds the id) keeps the row and logs a warning. A failed `edit` is logged as a warning and keeps the row.

### `plugins/dia-org/host.ts`

- In `holdRegistries`, after `registerBuiltIns`: `grantOrgRead(agentDefinitionRegistry)` with the org database's `SqlClient`.
- A `ctx.whenProvided([ToolsKey], ({ tools }) => …)` registers `makeOrgTools({ org, requestApproval: tools.requestApproval })` with `when: isAssistantScope`, and logs `Org tools registered`. It does not wait for the runs foundation: the tools need only `Org` and `Tools`.

`DiaRpcs` is unchanged, so `PROTOCOL_VERSION` is unchanged.

### Docs

`docs/adr/0071-executive-assistant-session.md:37` says the Assistant's session "runs in `dontAsk`"; `assistant.ts:167` starts it with the mode `runSettings` gives (`auto`, `bypassPermissions` or `default`). A `docs/reasoning/` entry, indexed in `docs/REASONING.md`, records this, because the org tools off the allow list depend on it: they go through the session's permission rules instead of being denied.

## Test plan

- `org-tools.test.ts`, over a real `makeOrg` on an in-memory database and a recording `requestApproval`:
  - each tool's change is visible through `jobTitles` / `hiredAgents`;
  - the approval table: each asking case calls `requestApproval` with the expected title, `before` and `after`; each non-asking case (plain edit, empty-rules edit, create with defaults, set enabled on a non-assistant) does not;
  - `'declined'` returns an error result and leaves the org unchanged; `'approved'` applies;
  - a missing target refuses without asking;
  - one refusal text per `Org` error tag reached;
  - `hire_rename` / `hire_set_reports_to` with `null`, and `staff_team` with an empty plan fails decoding.
- `handover.test.ts`, `grantOrgRead`: an edited assistant without the tool gains it; one that has it is unchanged; an unedited one gets no override; a pending handover keeps the row and changes nothing; a second run does nothing.
- `host.test.ts`: the test "offers the routing tools to the Executive assistant run only" (`host.test.ts:576`) expects the four routing tools plus the eleven org tools for an Assistant scope; a new case checks that a scope without `ASSISTANT_LABEL` is offered none of the eleven.

## Key Data Structures

- `ApprovalRequest` (`plugins/dia-tools/tools.ts`): `{ title: NonEmptyString, before: string, after: string }`.
- `JobTitle`, `JobTitleFields`, `JobTitleEdit`, `HiredAgent`, `TeamPlan` (`plugins/dia-org/domain.ts`), unchanged.

## Internal Decomposition

- **Input schemas** — one `Schema.Struct` per tool, built from the `domain.ts` schemas so an invalid id or name never reaches `Org`.
- **`approvalFor`** — the rule table above: from the target job title and the change, the `ApprovalRequest` to ask, or none.
- **`refusalText`** — the sentence for each `Org` error.
- **`orgCall`** — wraps one tool's effect: logs the call, maps refusals with `refusalText`, a decline to its error result, and a defect to `The <tool> call failed.`

## Design Rationale

**One tool per `Org` method** — the issue fixes the eleven names, and each tool's input is that method's parameters, so the tools hide nothing the agent must learn twice and add no rule of their own beyond approval.

**Ids, not names** — `org_read` returns ids and every change takes them. Name lookup (as `routing-tools.ts` does with `byIdOrName`) would make a hire rename ambiguous between a hire's name and its job title's name.

**Approval decided inside the tool** — ADR-0085 makes approval the handler's decision from the call's input; only the handler knows the target is the Executive assistant. The session's permission rules would skip these calls under `bypassPermissions`.

**Defaults for `job_title_create`** — the agent names only what it means to set; the defaults equal the "New job title" editor's (docs/designs/create-job-title.md), so a job title created either way starts the same.

**The grant is code, not a migration** — the issue asks for a migration, but job titles live in `agent-definitions` since `9_agent_definitions`; an org migration sees only the org database, so it records that the grant is pending and the host performs it through the registry.

**Required nullable fields for clearing** — `hire_rename.name` and `hire_set_reports_to.reportsTo` take `null` explicitly, so an agent that leaves a field out gets a decoding error instead of clearing a name or moving a hire to the user.

**The grant waits for the handover** — `handOverJobTitles` can import an Executive assistant override that lacks `ORG_READ_TOOL`; granting before that import would leave it ungranted. Deferring to a later launch is simpler than ordering two `whenProvided` callbacks.

## Rejected Alternatives

**Add `ORG_READ_TOOL` to `ROUTING_TOOLS`** — rejected: `ROUTING_TOOLS` names the routing tools of ADR-0053; reading the org is not routing.

**An org migration that edits the override** — rejected: migrations see only the org database; overrides live in `agent-definitions`.

**Ask approval for every job title change** — rejected: the issue limits approval to the Executive assistant and to permission and bypass changes; the rest go through the session's permission rules.

**Ask approval for `job_title_delete` of the Executive assistant** — rejected: `Org` always refuses deleting a built-in job title (`BuiltInJobTitleDeleted`), so the dialog would ask the user to approve a call that changes nothing. The issue lists it; the user confirmed skipping it, and the PR states the difference.

**Ask approval for `mcpServers` or `skills` changes** — rejected: an MCP server must already be configured by the user in the `mcp` registry, and the job title's `permissions`, which do ask, still gate its tools; the issue limits approval to permissions and the bypass opt-in.

**Ask approval for `job_title_copy`** — rejected: a copy holds rules the org already has in its source job title; the issue does not list it.

## Refinement Record

### Round 1

**Applied**
- *Correctness* — criterion 5 states that an override imported by the handover is granted from the next launch.
- *Issue deviation* — rationale "The grant is code, not a migration" added.
- *Issue deviation* — `job_title_delete` skip moved to Rejected Alternatives.
- *POLA / Define Errors Out* — `hire_rename.name` and `hire_set_reports_to.reportsTo` are required and nullable.
- *Define Errors Out* — `staff_team` input is `TeamPlan`, whose check fails an empty plan at decoding.
- *Project rule (docs consistent)* — reasoning entry for ADR-0071's stale `dontAsk`.
- *Project rule (tests)* — Test plan section.
- *Correctness* — empty-rules edit does not ask, stated.
- *Correctness* — `job_title_edit` input written as a spread struct; descriptions annotated in `org-tools.ts`.
- *Names* — `org_read` returns `name` (stored) and `displayName`.
- *JSDoc rule* — `makeOrgTools` drops "Each calls one `Org` method"; `grantOrgRead` drops the migration name; Executive assistant JSDoc reworded.
- *Correctness* — `after` is computed at request time; the result text reports the outcome.

**Rejected**
- *POLA: `job_title_copy` asks* — a copy holds rules already in the org; not in the issue. Recorded in Rejected Alternatives.
- *Unverified name collision* — rejected after a check: no other plugin registers `org_read`, `hire`, `staff_team`, `hire_*` or `job_title_*` (grep of `name: '…'` under `plugins/` and `src/host`).

### Round 2

No blocker or major finding; the rounds stopped here.

**Applied**
- *Test plan* — the existing host test that expects four Assistant tools is updated, not left red.
- *Correctness* — an edited Executive assistant keeps its job description, so the tool descriptions carry "call org_read first".
- *Correctness* — `staff_team`'s description states the at-least-one rule, which the JSON Schema omits.

**Rejected**
- *POLA: `mcpServers` / `skills` edits ask* — recorded in Rejected Alternatives: the servers are configured by the user and `permissions` still gate their tools; outside the issue.
