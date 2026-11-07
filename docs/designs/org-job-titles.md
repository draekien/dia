# Org job titles (#209)

Scope: module. Replaces the org's five built-in roles with seven built-in job titles, renames "role" to "job title" and "instructions" to "job description" in `plugins/org` and in the kernel's session option types, and records in a new ADR that planning and retro are kinds of task whose hired agent the user picks. Out of scope: task kinds, the scheduler and the planning and retro flows (#179, #181), the router (plan step 2), the org screens (#178).

Decisions confirmed with the user (2026-11-07):

| Decision | Choice |
| --- | --- |
| Built-in job titles | the seven in the table below; `router` stays as ADR-0053 defines it |
| Planning and retro | kinds of task; the user picks the hired agent of each one, as for any task; no job title is tied to them |
| First run | dia hires nobody; the retro warning goes |
| Old data | migration deletes the five old built-in roles and every hire of them; the user's copies and their hires stay |
| Vocabulary | `Role` → `JobTitle` and `instructions` → `jobDescription` in code, SQL and docs |
| Kernel names | `RoleMcpServer` → `McpServer`, `RoleSessionOptions` → `SessionToolOptions`, `role-session.ts` → `session-tools.ts`; the `AgentSessionOptions` field `role` becomes `tools`, and the existing `tools` (the dia tools) becomes `diaTools` |

## Interface

### Built-in job titles: `plugins/org/built-in-job-titles.ts` (replaces `built-in-roles.ts`)

| `kind` | `name` | `id` | `deny` |
| --- | --- | --- | --- |
| `product-manager` | Product manager | `6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0011` | `Edit`, `Write`, `NotebookEdit` |
| `software-engineer` | Software engineer | `…0012` | none |
| `quality-engineer` | Quality engineer | `…0013` | none |
| `business-analyst` | Business analyst | `…0014` | `Edit`, `Write`, `NotebookEdit` |
| `ui-ux` | UI/UX designer | `…0015` | none |
| `team-lead` | Team lead | `…0016` | `Edit`, `Write`, `NotebookEdit` |
| `technical-lead` | Technical lead | `…0017` | `Edit`, `Write`, `NotebookEdit` |

Ids are new (`0011`–`0017`), so no id of a deleted old built-in role is reused. Each seed is `{ id, kind, name, jobDescription, deny }`; `name` is a separate field because a built-in job title's name is no longer its kind. Every job description keeps the existing structure: one sentence stating the job, `## Core responsibilities`, `## Hard boundaries`, then the shared `EXECUTION_CONTRACT`. The content of each:

| Job title | Job | Boundaries |
| --- | --- | --- |
| Product manager | decide what to build and why: user problems, outcomes, priorities, acceptance criteria | no code or file changes |
| Software engineer | make the change a task describes, with tests, in small commits | change only what the task needs; no merge or push to the default branch |
| Quality engineer | test the work against its acceptance criteria; write and run tests; report each failure with the steps that reproduce it | change tests and test fixtures only, never the code under test |
| Business analyst | turn a request into requirements: actors, rules, edge cases, open questions | no code or file changes |
| UI/UX designer | design screens and flows against the project's design docs; change UI code and design files | change only the UI the task names |
| Team lead | break work into tasks, assign them, and run retros when asked | no code or file changes; do not do the tasks |
| Technical lead | decide technical approach, review designs and diffs, state each decision in the reply | no code or file changes; propose changes and decisions in the reply instead |

`DEFAULT_OVERALL_CAP` stays. `FIRST_RETRO_HIRE_ID` is removed. `BUILT_IN_JOB_TITLES`, its seed type `BuiltInJobTitleSeed` and `DEFAULT_OVERALL_CAP` each keep a JSDoc that states their purpose and how to consume them.

### `plugins/org/domain.ts`

```ts
/** The built-in job titles dia ships (ADR-0064). A built-in job title's name is fixed. */
export const BuiltInJobTitle = Schema.Literals([
  'product-manager', 'software-engineer', 'quality-engineer', 'business-analyst',
  'ui-ux', 'team-lead', 'technical-lead'
])
```

Renames, with fields and behaviour unchanged except where stated:

| Before | After |
| --- | --- |
| `BuiltInRole` | `BuiltInJobTitle` (new literals above) |
| `RoleId`, `RoleName`, `ROLE_NAME_MAX_LENGTH` | `JobTitleId`, `JobTitleName`, `JOB_TITLE_NAME_MAX_LENGTH` |
| `Role` (`instructions`) | `JobTitle` (`jobDescription`) |
| `RoleEdit` (`instructions`) | `JobTitleEdit` (`jobDescription`) |
| `HiredAgent.roleId` | `HiredAgent.jobTitleId` |
| `RoleNotFound { roleId }` | `JobTitleNotFound { jobTitleId }` |
| `RoleNameTaken { roleName }` | `JobTitleNameTaken { jobTitleName }` |
| `BuiltInRoleRenamed`, `BuiltInRoleDeleted` `{ roleId }` | `BuiltInJobTitleRenamed`, `BuiltInJobTitleDeleted` `{ jobTitleId }` |
| `RoleHasHires { roleId, hires }` | `JobTitleHasHires { jobTitleId, hires }` |
| `RoleDisabled { roleId }` | `JobTitleDisabled { jobTitleId }` |

Each error's `_tag` changes with its class name. JSDoc that says "role" says "job title".

### `plugins/org/service.ts`

`Org` members: `roles` → `jobTitles`, `setRoleEnabled` → `setJobTitleEnabled`, `copyRole` → `copyJobTitle`, `editRole` → `editJobTitle`, `deleteRole` → `deleteJobTitle`; `hire(jobTitleId, name)`; `hiredAgents`, `settings`, `dismiss`, `setOverallCap` keep their names. `MEMBERS` lists the new names. Log messages and span names (`Org.copyJobTitle`) follow.

### `plugins/org/org.ts`

Row schemas and SQL use the tables below. Behaviour does not change.

### `plugins/org/migrations.ts`

```ts
export const orgMigrations: PluginMigrations = {
  '1_create_org_tables': createTables,
  '2_seed_org': seedOrgSettings,
  '3_job_titles': moveToJobTitles
}
```

- `1_create_org_tables` is unchanged.
- `2_seed_org` keeps its key and now inserts only the `org_settings` row. Editing its body is safe because the Migrator records each migration by `migration_id` and `name` only (it skips every id up to the latest recorded one, `effect/src/sql/Migrator.ts:270`), so a database where it already ran does not run it again; a new database no longer gets the old roles and retro hire, which `3_job_titles` would delete.
- `orgMigrations`'s JSDoc names the three migrations and no longer mentions the first-run `retro` hire.
- `3_job_titles`, in the migrator's transaction with foreign keys on (`src/host/services/database.ts:49`, `effect/src/sql/Migrator.ts:331`):
  1. `CREATE TABLE job_titles` with `roles`' columns renamed (`role_id` → `job_title_id`, `instructions` → `job_description`) and the literal `built_in` `CHECK` list in Key Data Structures. A later change to a built-in job title needs a new migration.
  2. Insert the seven built-in job titles, enabled, with empty skills, allow, ask and MCP servers and `bypass_opt_in` 0.
  3. Select every `roles` row whose `built_in IS NULL`, in `rowid` order, and insert each into `job_titles` from TypeScript inside the migration Effect, keeping its `role_id` as its `job_title_id`. First insert every copy whose name no built-in job title and no other copy has, ignoring case, under its own name; then insert each remaining copy, in `rowid` order, under the name with ` (old)` appended, then ` (old 2)`, ` (old 3)` and so on until no inserted job title has it, with the base name cut so the result is at most `JOB_TITLE_NAME_MAX_LENGTH` (40) characters. A user copy therefore never makes the migration fail.
  4. `CREATE TABLE hired_agents_next` with `job_title_id TEXT NOT NULL REFERENCES job_titles`, and copy each `hired_agents` row whose `role_id` is a copied job title's id, with `job_title_id = role_id`. Count the hires not copied (`SELECT count(*) FROM hired_agents` minus the copied count) before step 5.
  5. `DROP TABLE hired_agents`, then `DROP TABLE roles` (this order satisfies the foreign key; nothing references `hired_agents`), then `ALTER TABLE hired_agents_next RENAME TO hired_agents`.
  6. Log `Effect.logInfo('Moved the org to job titles', { copiedJobTitles, copiedHires, droppedHires })`.

The seed table in step 2 is read from `BUILT_IN_JOB_TITLES`, as `2_seed_org` read `BUILT_IN_ROLES`.

### `plugins/org/host.ts`, `plugins/example/host.ts`

`plugins/org/host.ts` logs `jobTitles` in place of `roles`. `plugins/example/host.ts` reads `org.jobTitles`; its variable, log key and greeting (`· <n> job titles`) say job titles.

### Kernel: `src/shared/domain/session-tools.ts` (replaces `role-session.ts`)

| Before | After |
| --- | --- |
| `RoleMcpServer` | `McpServer` |
| `PermissionRules` | `PermissionRules` |
| `RoleSessionOptions` | `SessionToolOptions` |
| `AgentSessionOptions.role: Option<RoleSessionOptions>` | `AgentSessionOptions.tools: Option<SessionToolOptions>` |
| `AgentSessionOptions.tools: ReadonlyArray<DiaTool>` | `AgentSessionOptions.diaTools: ReadonlyArray<DiaTool>` |

JSDoc describes them as the permission rules and MCP servers a session gets in addition to its defaults, with none for an ad-hoc tab, and never mentions roles. `src/host/plugin-api.ts` exports the new names. `McpServer` is the exported schema name; no file that imports it also imports the MCP SDK's `McpServer` class (a repo grep finds no such import; `node_modules` not checked).

`plugins/claude-code` uses them:

- `session-tool-options.ts` imports `McpServer` from `@shared/domain/session-tools`; its `role` parameter and `NO_ROLE` become `tools` and `NO_TOOLS`.
- `session.ts`: `Pick<AgentSessionOptions, 'role'>` and `additions.role` become `'tools'` and `additions.tools`, the `Starting query session` log key `role` becomes `tools`, and `const { emit, tools } = options` (`session.ts:783`) reads `diaTools`.
- `tool-server.ts` is unchanged: `DiaToolServerOptions.tools` (`tool-server.ts:24`) is its own interface, which `session.ts` fills from `diaTools`.

Every construction of `AgentSessionOptions` passes `tools: Option.none()` or its value and `diaTools` in place of the old `tools`: `src/host/services/pane-supervisor.ts:213`, `src/host/session/agent-backend.test.ts`, `plugins/claude-code/session-context-usage.test.ts`, `session-rewind.test.ts`, `session-queue.test.ts` and `reducer.test.ts:124`.

`PLUGIN_API_VERSION` (`src/shared/plugin/manifest.ts:24`) becomes `0.0.28`, and the 13 `plugins/*/plugin.json` files (`adapters`, `agent-overview`, `chat`, `claude-code`, `claude-code-settings`, `command-palette`, `example`, `layout`, `meta`, `notifications`, `org`, `settings`, `worktrees`) declare `"api": "0.0.28"`; the registry refuses an incompatible `api` (`src/shared/plugin/plugin-registry.ts:952`). No test pins the version literal. `PROTOCOL_VERSION` is unchanged: `DiaRpcs` does not change.

## Documents

- New ADR `docs/adr/0064-job-titles-and-task-kinds.md`, added to the index. Decision: the vocabulary (job title, job description, hired agent); the seven built-in job titles and the router; planning and retro are task kinds assigned by the user like any task; no first-run hire. It amends ADR-0033 (built-in roles, "Retro and planner sessions are hired agents", the first-run retro and the "No retro is hired" warning, which is removed, and "An objective without an assignee goes to `planner`"), ADR-0034 (`planner` in the cut-at-decision and plan-review passages is the hired agent assigned to the planning task), ADR-0035 (the retro is a retro task run by the hired agent the user assigns; a finished task waits until its retro task is assigned and done), ADR-0036 (the hired agent running a retro task calls `propose_change`) and ADR-0053 (every `planner` reference: route `plan` and an unassigned objective create a planning task, which waits until the user assigns it). Each of ADR-0033, ADR-0034, ADR-0035, ADR-0036 and ADR-0053 changes its `status` front matter to `accepted, amended by ADR-0064` (keeping any existing amendments), gains an `Amended by ADR-0064: <one sentence>` paragraph beside the amended passage, and its row in `docs/adr/README.md` shows the same status; the README gains the 0064 row. Their other text is not rewritten.
- `docs/prds/org.md` and `docs/plans/2026-10-28-org.md` use the new vocabulary and task kinds.
- `docs/designs/org-roles-and-hiring.md` gains a first line: "Superseded in part by `docs/designs/org-job-titles.md` (#209): the names `role` and `instructions` (now job title and job description), the five built-in roles, and the first-run `retro` hire."
- `docs/designs/role-session-options.md` and `docs/designs/plugin-owned-contracts.md` gain a first line: "Superseded in part by `docs/designs/org-job-titles.md` (#209): `RoleMcpServer`, `RoleSessionOptions` and `role-session.ts` are now `McpServer`, `SessionToolOptions` and `session-tools.ts`."
- `docs/designs/typed-plugin-services.md` gains the same superseded-in-part first line as `org-roles-and-hiring.md`, naming the `Org` member renames.
- `PRODUCT.md` lines 33, 41, 42, 47 and 48 use job title and job description, and line 42 lists the seven built-in job titles.
- JSDoc that names the org role says job title: `src/host/session/start-permission-mode.ts:12`, and the `AgentSessionOptions` JSDoc in `agent-backend.ts`, which names `tools` and `diaTools`. `pane-supervisor.ts:545` (`role: message.message.role`) is a chat message role and is not renamed.
- ADR-0064's vocabulary paragraph states that ADR-0042, ADR-0043, ADR-0054 and ADR-0056 keep the word "role", which reads as "job title"; they are not amended.
- Issues #179 and #181 are edited to say planning task and retro task in place of `planner` and `retro`.

## Key Data Structures

```sql
CREATE TABLE job_titles (
  job_title_id    TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  built_in        TEXT    UNIQUE CHECK (built_in IN ('product-manager', 'software-engineer', 'quality-engineer', 'business-analyst', 'ui-ux', 'team-lead', 'technical-lead')),
  enabled         INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  job_description TEXT    NOT NULL,
  skills          TEXT    NOT NULL,
  permissions     TEXT    NOT NULL,
  mcp_servers     TEXT    NOT NULL,
  bypass_opt_in   INTEGER NOT NULL CHECK (bypass_opt_in IN (0, 1))
);
CREATE TABLE hired_agents (
  hire_id         TEXT    PRIMARY KEY,
  job_title_id    TEXT    NOT NULL REFERENCES job_titles,
  name            TEXT    UNIQUE COLLATE NOCASE,
  bypass_override INTEGER CHECK (bypass_override IN (0, 1)),
  hired_at        INTEGER NOT NULL
);
```

## Internal Decomposition

- **`built-in-job-titles.ts`** — owns what dia ships: ids, kinds, names, job descriptions, deny rules.
- **`migrations.ts`** — owns the table shapes and moving existing data to them.
- **`org.ts` / `service.ts` / `domain.ts`** — unchanged responsibilities under new names.
- **`session-tools.ts`** — owns the session tool option schemas, independent of who requests them.

## Design Rationale

**Rename the SQL tables in the same migration** — `built_in`'s `CHECK` lists the kinds and SQLite cannot alter a `CHECK`, so the table is rebuilt anyway; renaming costs nothing extra.

**`2_seed_org` stops seeding roles** — otherwise a new database inserts five roles and a hire only for `3_job_titles` to delete them, and `2_seed_org` would keep the deleted seeds alive in code.

**Kernel names without "job title"** — the kernel passes permission rules and MCP servers to a session; who asks for them (a hired agent, later the router or a routine) is not the kernel's concern.

**`tools` and `diaTools`** — chosen by the user at the gate: the session tool options take the name `tools`, so the existing field holding the dia tools (`agent-backend.ts:170`) is renamed `diaTools`, which also names what it holds.

**`name` separate from `kind` in a seed** — a built-in job title's name (`UI/UX designer`) is display text and its kind (`ui-ux`) is the stable key; they no longer coincide.

**Copies kept, clashing names suffixed** — a copy is the user's work; a rename avoids a migration failure that would leave the org plugin failed at startup.

## Rejected Alternatives

- **Keep the old built-ins as ordinary roles** — rejected by the user: only internal test databases hold them.
- **Kernel names `JobTitleMcpServer`, `JobTitleSessionOptions`** — rejected by the user: an MCP server does not belong to a job title.
- **A planning and a retro job title** — rejected by the user: planning and retro are tasks.

## Tests

- `plugins/org/org.test.ts` (`org seed`): a new database lists exactly the seven built-in job titles in table order, enabled, with their names and kinds (so none is named by its kind), each with the deny rules in the table, and no hires.
- `plugins/org/migrations.test.ts` (new), legacy upgrade: open a temp database file through `openDatabase` (`src/host/services/database.ts`, which turns on foreign keys) with `orgMigrations['1_create_org_tables']` and a key `2_seed_org` whose body is a test-local copy of the old seed (the five old built-in roles, hard-coded, and the first-run retro hire); insert with SQL a copy named `Strict engineer` with the hire `brave-otter`, a copy named `team LEAD`, a copy named `Team lead (old)`, and a hire of the old `engineer`; close it; reopen with the full `orgMigrations`. Migration 2 is already recorded, so only `3_job_titles` runs. Expected: the seven built-ins, then `Strict engineer`, `team LEAD (old 2)` and `Team lead (old)` with their own ids and their instructions as job descriptions; `brave-otter` as the only hire; `PRAGMA foreign_key_check` returns no rows, and inserting a hire with an unknown `job_title_id` fails.
- `plugins/org/org.test.ts`: the `hires one unnamed retro` and `does not hire the first retro again` cases are deleted (no first-run hire; covered by migrations case 1). The built-in listing and deny cases use the seven names and kinds; its lookup helpers find a job title by name.
- `plugins/org/domain.test.ts`: renamed.
- `plugins/claude-code/session-tool-options.test.ts`, `session-queue.test.ts`, `session-rewind.test.ts`, `session-context-usage.test.ts` and `src/host/session/agent-backend.test.ts`: renamed types, field and parameter.

## Verification

Through the `verify-in-app` skill on a packaged build with a scratch profile: the org plugin loads with no error line in `app.log`, and the Example page's greeting reads `· 7 job titles`.

## Refinement Record

### Round 1 (subagent, sonnet)

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | major | `AgentSessionOptions.role` is set in more files than named (`session.ts` `Pick`/`additions.role`, four test files) | applied; verified by grep |
| 2 | major | `plugins/example/host.ts:23` reads `org.roles`; `RoleMcpServer` is imported directly in claude-code | applied; verified |
| 3 | major | `org.test.ts` first-run retro cases test removed behaviour | applied |
| 4 | major | `substr(...) || ' (old)'` can clash with an existing copy and fail the migration | applied: per-row free name in TypeScript, numbered suffix |
| 5 | major | no test pins `0.0.27`; list the 13 manifests | applied; verified |
| 6 | major | legacy migration test harness contradicted itself | applied: test-local `2_seed_org`, reopen with full migrations |
| 7 | major | ADR amendment must change `status` front matter (ADR-0010 precedent) | applied; verified |
| 8 | minor | `droppedHires` count source unstated | applied |
| 9 | minor | two more designs name the old kernel types | applied: superseded-in-part first lines |
| 10 | minor | superseded line in `org-roles-and-hiring.md` not literal | applied |
| 11 | minor | JSDoc on new exports and `orgMigrations` | applied |

### Round 2 (subagent, sonnet)

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | major | copies must keep `role_id` as `job_title_id`, or step 4 cannot map hires | applied |
| 2 | minor | migration must not read the `CHECK` list from live code | applied: literal list; seeds still from `BUILT_IN_JOB_TITLES` as `2_seed_org` did |
| 3 | minor | test does not assert the foreign key survives the rebuild | applied |
| 4 | minor | test must hard-code the old rows and call migration 1 by key | applied |
| 5 | minor | criterion 4 not in the spec | applied: Verification section |
| 6 | major | `typed-plugin-services.md`, `PRODUCT.md`, two JSDoc sites and other ADRs not covered | applied; verified `PRODUCT.md:33-48`, `start-permission-mode.ts:12` |
| 7 | minor | note on aliasing `McpServer` against the SDK class | rejected: no file imports both; a note for a future file is speculative |
| — | minor | `Migrator.ts:131-132` cites the mssql DDL | applied: cites `Migrator.ts:270` |

### Round 3 (subagent, sonnet)

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | major | rowid-order renaming renames the user's `Team lead (old)` copy, contradicting the test | applied: free names inserted first, clashing copies suffixed after |
| 2 | major | Technical lead "record decisions" contradicts its read-only deny | applied: decisions stated in the reply |
| 3 | major | ADR-0034 names `planner` (lines 55, 60); ADR-0053 has more `planner` passages | applied: ADR-0034 amended; ADR-0053 amendment covers every `planner` reference |
| 4 | minor | "finished task waits for its retro task" and warning removal not stated | applied |
| 5 | minor | `toolOptions` deviates from the issue's `tools` | escalated; the user chose `tools` and renamed the dia tools field to `diaTools` |
| 6 | minor | rationale missing for `toolOptions` and the seed's `name` field | applied |
| 7 | minor | FK assertion needs foreign keys on in the test connection | applied: test opens through `openDatabase` |
