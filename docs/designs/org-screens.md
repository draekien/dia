# Org screens (#178)

Superseded in part by `docs/designs/mcp-plugin.md`: `mcp-json.ts` moved to `plugins/mcp/servers.ts`, and the MCP servers textarea is the editor the mcp plugin provides; while mcp is not loaded the field shows `Load the mcp plugin to edit MCP servers`.

Scope: module. Adds the org's screens: an **Org** page in the sidebar whose own sub-navigation holds four pages (Dashboard, Org chart, Job titles, Hired agents), and an **Org** page in the Settings dialog (the overall cap). To do that it adds a reporting line between hired agents (`HiredAgent.reportsTo`), three `Org` operations, `renameHire`, `setBypassOverride` and `setReportsTo`, and a `reportsTo` argument to `hire`; the org calls its host entry serves; and a renderer entry for `plugins/org` that adds a page to `PagesSlot` (ADR-0061), a page to `SettingsPagesSlot` and a search-only palette command (ADR-0063). The kernel does not change. Out of scope: objectives, tasks, planning and retro tasks, and the scheduler (#179 and later), a structured MCP server form (#197), model choice per job title.

Vocabulary follows ADR-0064: a hired agent is hired into a **job title**, whose **job description** is appended to its sessions' system prompt. dia hires nobody on first run, and no screen warns about a missing retro.

Decisions taken with the user in Understand (2026-11-07): the overall cap lives on a plugin Settings page (option C), built in this PR; bypass controls are hidden when managed or user Claude Code settings disable `bypassPermissions` (option A); MCP servers are edited as JSON (option A, #197 for a form); copied job titles can be deleted.

Decisions taken with the user on 2026-11-07:

| Decision | Choice |
| --- | --- |
| How to move between org pages | one `Org` sidebar entry; the Org page draws its own sub-navigation (no layout change) |
| Which pages #178 builds | Dashboard, Org chart, Job titles, Hired agents. Each later #40 sub-issue adds its page or section to the same sub-navigation (see Later pages) |
| Org chart | a tree of hired agents only; a job title is an attribute shown on each agent, never a node |
| Where the tree's edges come from | a new `reportsTo` field on `HiredAgent`; null means the agent reports to the user |
| Dashboard | a stat row, then a "Needs attention" list with a fix button per item |
| Hired agents page | a list and detail page, the same form as Job titles; every agent action lives only there |

### Later pages

| Issue | Adds to the Org page |
| --- | --- |
| #179 | Dashboard: `Running now (<n> of <cap>)` in the stat row, a Waiting tasks section, and a Needs attention item per planning or retro task with no agent assigned; with a second kind of item, #179 adds `attention.ts` with an `AttentionItem` union. Hired agents detail and Org chart nodes: the agent's current task |
| #180 | an Objectives page in the sub-navigation, between Dashboard and Org chart, with the objective form and objective screen |
| #181 | Dashboard: a "Task lists to approve" section |
| #182 | Hired agents detail: open the agent's session |
| #197 | Job titles detail: the structured MCP server form |

## Interface

### Settings page and palette command (ADR-0063)

The renderer entry adds the Org Settings page and its palette command the way `plugins/meta/renderer.ts` adds Meta repo:

```ts
yield* addEntry(ctx, SettingsPagesSlot, {
  id: 'org',
  order: 50,
  label: 'Org',
  icon: UsersIcon,
  component: OrgSettingsPage
})
yield* addEntry(ctx, CommandsSlot, {
  id: 'org-settings',
  order: 150,
  group: 'Settings pages',
  label: 'Settings › Org',
  icon: SettingsIcon,
  keywords: ['org', 'cap', 'hired agents', 'running at once'],
  searchOnly: true,
  run: () => openSettings({ plugin: 'org', id: 'org' })
})
```

Imports follow `plugins/meta/renderer.ts` and `plugins/example/renderer.ts`: slots from `@dia-plugin/<plugin>/slots`, `addEntry` and `openSettings` from `@dia/renderer-plugin`. Order 50 places Org after Meta repo (40). `OrgSettingsPage` takes `SettingsPageProps` and has no sections, so it ignores them. The Settings dialog draws the nav entry and breadcrumb, removes the page when the org plugin unloads, and shows `PluginFailed` if the page throws.

### Org service: `plugins/org/service.ts`

`renameHire` and `setBypassOverride` are implemented on this branch (commit `c49dcc9`). This design adds `setReportsTo` and changes `hire` and `dismiss`:

```ts
/** Makes hired agent `hireId` report to hired agent `reportsTo`, or to the user when null. */
readonly setReportsTo: (hireId: HireId, reportsTo: HireId | null) => Effect<HiredAgent, HireNotFound | ReportsToCycle>
/** (changed) Hires an agent of job title `jobTitleId`, named `name` or unnamed when null, reporting to `reportsTo` or to the user when null. */
readonly hire: (jobTitleId: JobTitleId, name: AgentName | null, reportsTo: HireId | null) => Effect<HiredAgent, JobTitleNotFound | JobTitleDisabled | HireNameTaken | HireNotFound>
```

Each runs in one transaction in `plugins/org/org.ts`, as the other changes do, and logs `Effect.logInfo` with the hire id. The `Org` interface's JSDoc gains a sentence for `setReportsTo` and the `reportsTo` argument, and `service.ts`'s `MEMBERS` record lists `setReportsTo`.

- `setReportsTo` and `hire` fail with `HireNotFound` carrying the missing id in `hireId` when `reportsTo` is not a hire; `setReportsTo` checks `hireId` before `reportsTo`. `setReportsTo` fails with `ReportsToCycle { hireId, reportsTo }` when `reportsTo` is `hireId` or one of `descendantsOf(hiredAgents, hireId)`.
- `descendantsOf(hiredAgents, hireId)`, exported from `domain.ts`, returns the ids of every hire that reports to `hireId` through any chain of `reportsTo` values. The service reads all hires inside the `setReportsTo` transaction and calls it; `reportsToChoices` calls it too, so the cycle rule has one definition.
- `dismiss` (changed) first sets every hire that reports to the dismissed hire to report to the dismissed hire's own `reportsTo`, then deletes it, in one transaction.

`plugins/org/domain.ts` changes:

```ts
export const HiredAgent = Schema.Struct({
  id: HireId,
  jobTitleId: JobTitleId,
  name: Schema.NullOr(AgentName),
  bypassOverride: Schema.NullOr(Schema.Boolean),
  reportsTo: Schema.NullOr(HireId),
  hiredAt: Schema.Number
})

/** Failure of setting a reporting line: `reportsTo` is `hireId` or already reports to `hireId`. */
export class ReportsToCycle extends Schema.TaggedError<ReportsToCycle>()('ReportsToCycle', {
  hireId: HireId,
  reportsTo: HireId
}) {}
```

`plugins/org/migrations.ts` gains `'4_add_reports_to'`: `ALTER TABLE hired_agents ADD COLUMN reports_to TEXT REFERENCES hired_agents(hire_id)`. Existing hires get null, so they report to the user. SQLite allows adding a column with a `REFERENCES` clause while foreign keys are on only when its default is null, which it is; the migration test checks it.

Also changes: `HireRow`, `toHiredAgent`, `toHireRow` and the `HiredAgent.make` call in `org.ts` carry `reportsTo`; `orgMigrations`' JSDoc lists `4_add_reports_to`; `HireNotFound`'s JSDoc covers a missing `reportsTo`; the `Hire` call's JSDoc and error union gain `reportsTo` and `HireNotFound`; test fixtures that build a `HiredAgent` gain `reportsTo: null`.

### Org calls: `plugins/org/calls.ts`

Declared with `Rpc.make` (ADR-0057), each with a struct payload and a JSDoc line. No payload field is named `plugin`, `tag` or `payload` (the `CallPlugin` wrapper's fields, root `CLAUDE.md`). Every call except `SetReportsTo` and the `reportsTo` field of `Hire` exists on this branch.

| Tag | Payload | Success | Error |
| --- | --- | --- | --- |
| `ReadOrg` | `{}` | `OrgSnapshot` | none |
| `SetJobTitleEnabled` | `{ jobTitleId, enabled }` | `JobTitle` | `JobTitleNotFound` |
| `CopyJobTitle` | `{ jobTitleId, name: JobTitleName }` | `JobTitle` | `JobTitleNotFound \| JobTitleNameTaken` |
| `EditJobTitle` | `{ jobTitleId, edit: JobTitleEdit }` | `JobTitle` | `JobTitleNotFound \| JobTitleNameTaken \| BuiltInJobTitleRenamed` |
| `DeleteJobTitle` | `{ jobTitleId }` | `Void` | `JobTitleNotFound \| BuiltInJobTitleDeleted \| JobTitleHasHires` |
| `Hire` | `{ jobTitleId, name: NullOr(AgentName), reportsTo: NullOr(HireId) }` | `HiredAgent` | `JobTitleNotFound \| JobTitleDisabled \| HireNameTaken \| HireNotFound` |
| `Dismiss` | `{ hireId }` | `Void` | `HireNotFound` |
| `RenameHire` | `{ hireId, name: NullOr(AgentName) }` | `HiredAgent` | `HireNotFound \| HireNameTaken` |
| `SetBypassOverride` | `{ hireId, override: NullOr(Boolean) }` | `HiredAgent` | `HireNotFound` |
| `SetReportsTo` | `{ hireId, reportsTo: NullOr(HireId) }` | `HiredAgent` | `HireNotFound \| ReportsToCycle` |
| `SetOverallCap` | `{ cap: OverallCap }` | `OrgSettings` | none |

ADR-0057 allows a call to be resent while the Host connection is down, so a handler can run more than once (`docs/adr/0057-plugin-pages-and-plugin-messages.md:45`). `SetJobTitleEnabled`, `EditJobTitle`, `RenameHire`, `SetBypassOverride`, `SetReportsTo` and `SetOverallCap` set a value and are safe to repeat. `Dismiss` and `DeleteJobTitle` fail with `HireNotFound` / `JobTitleNotFound` on a repeat; the renderer treats that error as success for these two calls and refreshes `orgAtom`. `Hire` and `CopyJobTitle` are not safe to repeat: a resent call can add a second unnamed hire, or fail with `HireNameTaken` / `JobTitleNameTaken` after the first call succeeded. This is accepted; the user removes a duplicate with `Dismiss` or `Delete…`.

```ts
/**
 * What the org screens show: every job title, every hired agent, the org settings, and whether
 * any session could start in `bypassPermissions` (false when managed or user Claude Code settings
 * disable it, or no agent backend is provided; ADR-0054).
 */
export const OrgSnapshot = Schema.Struct({
  jobTitles: Schema.Array(JobTitle),
  hiredAgents: Schema.Array(HiredAgent),
  settings: OrgSettings,
  bypassAvailable: Schema.Boolean
})
```

`plugins/org/plugin.json` lists `calls.ts` in `exports` (ADR-0059), and `tsconfig.plugin-exports.json` and `tsconfig.web.json` include it. `calls.ts` imports the org schemas from `./domain` and `AgentName` from `@dia/plugin`. `host.ts` and the renderer files import the calls from `./calls`.

### `plugins/org`

| File | Change |
| --- | --- |
| `plugin.json` | `"renderer": "renderer.ts"`, `"load": "eager"`; `api` stays `0.0.28`. No `inject`: an `inject` key without a provider puts the plugin in `Waiting` (`src/shared/plugin/plugin-registry.ts:845-851`), and the renderer registry reads the same manifest with no provider of `agentBackend` |
| `host.ts` | serves each call after providing `OrgService` (done on this branch); `SetReportsTo` is added. `ReadOrg` reads `jobTitles`, `hiredAgents`, `settings` and `bypassAvailable`; these are separate reads, not one transaction, so a change landing between them shows after the next refresh, which every change triggers |
| `bypass.ts` | `bypassAvailable(ref)` (done on this branch): `false`, logged at debug level, while no agent backend is provided; otherwise whether `disabledPermissionModes(homedir())` omits `bypassPermissions`. `plugins/claude-code/permission-settings.ts:44` calls `resolveSettings({ cwd })` with no `settingSources`, so managed and user settings are read whatever the cwd, and `cwd` only locates project and local settings (`sdk.d.ts:3404-3412`, SDK 0.3.311); other directories' project and local settings are covered by ADR-0054's per-session check |
| `renderer.ts` | `addEntry(ctx, PagesSlot, { id: 'org', order: 10, label: 'Org', icon: UsersIcon, component })`, the Settings page and the palette command above; one `orgAtom = Atom.make(callHost(ctx, ReadOrg, {}))` shared by both pages |
| `org-view.ts` | the `OrgView` union (below) and `showView(snapshot, view)`, which returns the view to draw when its selected job title or hire is no longer in the snapshot |
| `org-page.tsx` | the Org page: its sub-navigation, the read states, and the current `OrgView` |
| `dashboard.tsx` | the stat row and the Needs attention list |
| `org-chart.tsx` | the tree of hired agents |
| `org-tree.ts` | `orgTree(hiredAgents)`, the tree the chart draws, and `reportsToChoices(hiredAgents, hireId)`, the hires a hire may report to |
| `job-titles-page.tsx` | the job title list and the selected job title's detail |
| `job-title-editor.tsx` | the selected job title's detail: heading row, edit form and the names of its hired agents |
| `agents-page.tsx` | the hired agent list and the selected agent's detail |
| `hire-dialog.tsx` | the Hire dialog (name, job title, Reports to) |
| `org-settings-page.tsx` | the overall cap |
| `mcp-json.ts` | turns the MCP textarea text into `JobTitleEdit.mcpServers`, and a job title's servers back into text |
| `org-actions.ts` | `useOrgCall` (sends a call, logs it, and resolves after the refresh of `orgAtom` that follows a success or a not-found error), the shared failure text, name field readers, `agentName`, and `OrgScreen`, the props every sub-page takes |
| `entry-list.tsx` | the `listbox` both list and detail pages use |
| `org-fields.tsx` | `ReportsToSelect`, used by the Hire dialog and the Hired agents detail, and `LoadFailure`, the failed-read message with `Try again` both pages show |
| `name-dialog.tsx`, `confirm-dialog.tsx` | the one-name-field dialog (`Copy…`, `Rename`) and the confirm alert dialog (`Delete…`, `Dismiss…`) |
| `org-host.fake.tsx` | a fake `org` host entry behind `window.dia.plugins.call`, and the fixture snapshot, for the component tests |

`org-view.ts`, `org-tree.ts`, `mcp-json.ts` and `org-actions.ts` are added to `tsconfig.web.json`'s `include`, and `org-actions.ts` to `tsconfig.node.json`'s `exclude` (it imports `@dia/renderer-plugin`) (it lists `plugins/**/renderer.ts`, `plugins/**/*.tsx` and named `.ts` files). `renderer.ts` passes `ctx` and `orgAtom` to both page components by closure with `createElement`, because `Page.component` takes no props and `SettingsPage.component` takes only `SettingsPageProps` (`plugins/example/renderer.ts`).

`@dia/renderer-plugin` already exports `Skeleton`, `ToggleGroup` and `Empty` (#208). `src/renderer/src/plugin-api.ts` also exports any shadcn component the `/impeccable` design adds, installed through the `shadcn` skill.

## Key Data Structures

`org-view.ts`:

```ts
export const DashboardView = Schema.TaggedStruct('DashboardView', {})
export const OrgChartView = Schema.TaggedStruct('OrgChartView', {})
export const JobTitlesView = Schema.TaggedStruct('JobTitlesView', { jobTitleId: Schema.NullOr(JobTitleId) })
export const HiredAgentsView = Schema.TaggedStruct('HiredAgentsView', { hireId: Schema.NullOr(HireId) })
/** Which Org sub-page is shown, and on the two list pages which entry is selected; null selects the first entry. */
export const OrgView = Schema.Union([DashboardView, OrgChartView, JobTitlesView, HiredAgentsView])
export type OrgView = typeof OrgView.Type
```

Each exported member carries a one-line JSDoc. Views are built with each member's `.make`. `showView` replaces a selection the snapshot does not hold with null. Every path that selects an id the user just created sets the view only after the refresh that contains it resolves.

```ts
/** One agent in the org chart and the agents that report to it, ordered by `hiredAt`. */
export interface OrgNode {
  readonly agent: HiredAgent
  readonly reports: ReadonlyArray<OrgNode>
}
```

`OrgNode` is a plain interface because it has no schema. `orgTree` returns the nodes that report to the user; agents with the same `hiredAt` keep their order in the snapshot. A hire whose `reportsTo` names no hire in the list is a root; the service's foreign key and `dismiss` keep this from happening, and the chart still shows every hire if it does.

Every other type is existing (`JobTitle`, `HiredAgent`, `OrgSettings`, `JobTitleEdit`, the org errors, `Page`, `SettingsPage`, `CommandEntry`).

## Renderer behaviour

- **Reads**: both pages read `orgAtom` (`AsyncResult`): `Initial` shows a skeleton, `Failure` shows the error message in error red with `Try again`, `Success` shows the screen. A refresh (`useAtomRefresh`, `@effect/atom-react`) keeps showing the last snapshot until the new one arrives. When neither page has read the atom for 400 ms (`appRegistry`'s `defaultIdleTTL`, `workspace-atoms.ts:21`), the next open reads again. A backend provided after a read does not refresh an open page; the next change or reopen reads `bypassAvailable` again.
- **Changes**: each change runs `callHost(ctx, <Call>, payload)`. On success the page refreshes `orgAtom`.
- **Name inputs**: job title, hire and rename inputs are trimmed and decoded with `JobTitleName` / `AgentName` before any call, because `callHost` runs `payloadSchema.make` (`src/renderer/src/lib/plugin-messages.ts:32`), which throws on an invalid branded value. A blank hire or rename input becomes `null`. A blank job title name, or a name over the maximum length, shows its message beside the field and sends nothing.
- **An unnamed agent** is shown as `Unnamed <job title name>`.
- **Org page**: the content header reads `Org`, the page's label (`PageCrumb`, `plugins/layout/layout.tsx:65-75`); a page cannot add crumbs, and the layout does not change. The sub-navigation lists Dashboard, Org chart, Job titles and Hired agents, in that order, and the page draws the current sub-page's name as its own heading under it. The `OrgView` lives in `OrgPage`'s `useState`, not an atom, so the page opens on Dashboard each time it opens. Every change handler logs `Effect.logInfo` with the call tag and target id, and every failure logs `Effect.logWarning` with its tag. Selecting an agent (an Org chart node, a Job titles detail name, the Hire dialog on success) shows Hired agents with that agent selected; a Needs attention fix button opens the dialog or page that fixes its item; selecting a job title name in Hired agents detail shows Job titles with it selected.
- **Dashboard**: a stat row of `Hired agents <n>`, `Job titles <enabled> of <total> enabled` and `Running at once <cap>`, the last with an outline `Change` button that runs `openSettings({ plugin: 'org', id: 'org' })`. Below it, `Needs attention`: while `hiredAgents` is empty it shows one item that reads "No agents are hired. Hire one to start building the org." with an outline `Hire…` that opens the Hire dialog. With no items the section reads "Nothing needs attention."
- **Org chart**: a tree with a `You` root; each node shows the agent's name and its job title name, ordered by `hiredAt` under its parent. Selecting a node shows Hired agents with that agent selected. With no hires it shows an `Empty` state, "No agents are hired", with `Hire…`.
- **Job titles**: a 14rem list on the left and the selected job title's detail on the right, at most 48rem wide; below 48rem of content width the list sits above the detail. List row: name, hire count right-aligned, `Disabled` in muted text on a disabled job title; one `listbox` with arrow-key selection; the selected row uses the agent overview's selected-row fill.
  - Heading row: the name, `Built in` caption on built-in job titles, the enabled switch, then outline `Copy…` and `Hire…`, and `Delete…` on copies only. `Copy…` opens a small dialog with one name field. `Hire…` opens the Hire dialog with this job title chosen. `Delete…` opens an alert dialog naming the job title; it is deleted only on the confirm button.
  - Edit form, with `Save` at its end; `Save` sends `EditJobTitle` with the fields that changed and is disabled while nothing changed. Fields: name (copies only; a built-in job title's name is read-only), job description (textarea), skills (one name per line, mono), allow / ask / deny (one rule per line each, mono), MCP servers, bypass opt-in (switch, hidden when `bypassAvailable` is false, captioned `Runs tools without asking when auto mode is unavailable. Plugin changes still ask.`, ADR-0054).
  - `Hired as <job title name>`: the names of its hired agents; each opens Hired agents with that agent selected. No agent actions here.
- **MCP servers field** (`mcp-json.ts`): a mono textarea holding the record `{ "<server>": { ... } }`, not the `{ "mcpServers": ... }` wrapper. The text is parsed with `Schema.fromJsonString`. Before decoding, an entry without `type` that has `command` gets `type: 'stdio'`; a stdio entry missing `args` or `env` gets `[]` / `{}`; an http or sse entry missing `headers` gets `{}`. It is then decoded with `JobTitle.fields.mcpServers`, so the record shape has one definition. A JSON syntax error or the first schema issue shows in error red and nothing is sent. Keys the schema does not know are dropped; after a save the textarea shows the saved value.
- **Hired agents**: the same list and detail split as Job titles. An outline `Hire…` above the list opens the Hire dialog with no job title chosen. List row: the agent's name, its job title name in muted text. With no hires the page shows the `Empty` state of the Org chart. Detail:
  - heading: the name, `Rename` (a dialog with one name field), `Dismiss…`, which opens an alert dialog, `Dismiss <name>?`, adding `Its <n> reports will report to <manager name or You>.` (`Its report will report to …` for one) when it has reports; the agent is dismissed only on the confirm button;
  - `Job title`: the job title name, which opens Job titles with it selected;
  - `Reports to`: a select of `You` and `reportsToChoices(hiredAgents, hireId)`; a change sends `SetReportsTo`;
  - `Bypass approvals`: `Follow job title` / `On` / `Off`, hidden when `bypassAvailable` is false; a change sends `SetBypassOverride`;
  - `Hired`: the `hiredAt` date.
- **Hire dialog**: name (optional), job title (a select of enabled job titles; fixed when opened from a job title; none chosen when opened elsewhere, and `Hire` is disabled until one is), Reports to (a select of `You` and every hire; default `You`). `Hire` sends `Hire`. On success the page refreshes `orgAtom` and, once the refresh resolves, sets `HiredAgentsView.make({ hireId })`, so `showView` never sees a selection newer than its snapshot.
- **Failures** (`Schema.TaggedError` classes carry no message text, so the screen supplies the copy):

  | Call | Shown where | Text |
  | --- | --- | --- |
  | `CopyJobTitle`, `EditJobTitle` | under the name field | `A job title named "<name>" already exists` (`JobTitleNameTaken`); `A built-in job title keeps its name` (`BuiltInJobTitleRenamed`) |
  | `Hire`, `RenameHire` | under the name field | `An agent named "<name>" already exists` (`HireNameTaken`) |
  | `Hire` | under the Hire button | `This job title is disabled` (`JobTitleDisabled`) |
  | `DeleteJobTitle` | in the delete dialog | `Dismiss its <n> hired agents first` (`Dismiss its hired agent first` when 1) (`JobTitleHasHires`) |
  | `SetReportsTo` | under the Reports to field | `An agent cannot report to itself` (`ReportsToCycle` with `reportsTo` equal to `hireId`); `<reportsTo name> already reports to <name>` (other `ReportsToCycle`); the field keeps the saved value |
  | `SetReportsTo`, `Hire` | under the Reports to field | `The selected manager was dismissed` (`HireNotFound` whose `hireId` is the `reportsTo` argument), and `orgAtom` is refreshed |
  | `Dismiss` | in the dismiss dialog | the reason |
  | `SetJobTitleEnabled`, `SetBypassOverride` | error toast (DESIGN.md › Toast) | title `Could not <action> <name>`, the reason as description |
  | any except `Dismiss` and `DeleteJobTitle`, whose not-found error is success | as the call's row above, or a toast | `JobTitleNotFound` / `HireNotFound`: `This job title was removed` / `This agent was dismissed`, and `orgAtom` is refreshed because the screen is out of date |
  | any | as the call's row above, or a toast | `PluginNotServing` / `PluginCallInvalid`: their `message` |
- **Org settings page**: "Hired agents running at once" number input, min 1, step 1, saved on blur or Enter; an invalid value shows "Enter a whole number of 1 or more" in error red and is not sent.

The screens' visual design, including the sub-navigation's form, is made with `/impeccable` against fixture `OrgSnapshot` values and passes its finish review against `DESIGN.md` before `orgAtom` reads real data (issue #178). The surface brief `.impeccable/surfaces/plugins-org-org-page-tsx.md` describes the single role page and is rewritten by that step.

## Internal Decomposition

- **`plugins/org/calls.ts`** — owns the wire contract between the org plugin's two entries.
- **`plugins/org/host.ts`** — owns serving the calls and holding the agent backend while it is provided.
- **`plugins/org/bypass.ts`** — owns deciding whether bypass is available.
- **`plugins/org/org-tree.ts`** — owns the reporting structure as the renderer sees it: the tree and the valid Reports to choices. The chart, the Hire dialog and the Hired agents detail know neither the cycle rule nor how roots are found.
- **`plugins/org/org-view.ts`** — owns which sub-page and selection are shown, and what happens to a selection that disappears.
- **`plugins/org/mcp-json.ts`** — owns the MCP servers text format.
- **`plugins/org` renderer files** — own the screens; they know the calls, never the `Org` service.

## Design Rationale

**The agent backend through `whenProvided`** — the org works without a backend (only `bypassAvailable` uses it), which is the case ADR-0056 covers; `inject` would stop the whole plugin, and its renderer entry, until a backend is provided.

**Call declarations in an exported plugin module** — the org schemas live in `plugins/org/domain.ts`, and an exported module resolves `@dia/plugin` in both the Host and the renderer build (ADR-0059). The calls sit beside the schemas in `plugins/org/calls.ts`, so the kernel holds no org contract.

**One `ReadOrg` snapshot** — every page needs parts of the same data, and a change can affect several parts (dismissing an agent changes a job title's count and moves its reports), so the renderer refreshes one value after every change instead of patching parts.

**`reportsTo` on the hire, cycles refused in the service** — the reporting line is a fact about one hire, so it lives on `HiredAgent`. The service refuses a cycle so `orgTree` always yields a tree; `reportsToChoices` only keeps the select from offering a choice the service would refuse.

**`bypassAvailable` at the home directory** — chosen with the user (option A): the org spans every project, and ADR-0054's per-session check still reads each project's settings.

**Eager load** — a lazy host entry can serve `ReadOrg` after the page's first call, which would then show `PluginNotServing` during startup (ADR-0027).

## Rejected Alternatives

- **Org settings in the Org page header, or as a second sidebar page** — rejected by the user in Understand.
- **One page with the role list, detail and hires** — the first layout of this design; replaced by four sub-pages when the user chose them on 2026-11-07.
- **Job titles as nodes of the org chart** — rejected by the user: only agents are nodes.
- **Structured MCP form** — deferred to #197.
- **`Dismiss` and `DeleteJobTitle` succeeding when the target is absent** — this would remove the renderer's special case for a resent call, but it changes the org service's existing, tested contract (`HireNotFound` / `JobTitleNotFound`); the screens handle both errors instead.
- **Calls in `src/shared/domain`** — #207 moved the org domain out of the kernel; calls there would bring an org contract back into it.
- **A kernel `addSettingsPage`** (the first version of this design, never merged) — replaced by `SettingsPagesSlot` in #204 (ADR-0063).

## ADR and versions

- No new ADR: Settings pages and palette commands follow ADR-0063, exported modules ADR-0059, the vocabulary ADR-0064.
- `PLUGIN_API_VERSION` stays `0.0.28`: the kernel API does not change. `PROTOCOL_VERSION` is unchanged: `DiaRpcs` does not change.

## Tests

- `plugins/org/org.test.ts`: `renameHire` and `setBypassOverride` (done on this branch); `setReportsTo` (to another hire, to null, to itself refused, to a hire that reports to it through two levels refused, unknown `hireId` and unknown `reportsTo` refused, and both unknown gives `HireNotFound` for `hireId`); `hire` with a `reportsTo` stores it and with an unknown one is refused; `dismiss` moves the dismissed hire's reports to its own `reportsTo`, both for a mid-chain hire and for a hire reporting to the user, whose reports then report to the user; an `editJobTitle`, a `renameHire`, a `setReportsTo` and a `setOverallCap`, then the org reopened on the same temp-file database, still hold.
- `plugins/org/migrations.test.ts`: `4_add_reports_to` on a database with hires gives each hire `reportsTo: null` and leaves `PRAGMA foreign_key_check` empty; deleting a hire that another hire reports to without moving its reports fails.
- `plugins/org/host.test.ts` (done on this branch, through a real registry): `ReadOrg` returns the seeded snapshot; one change per call reaches the service; `bypassAvailable` follows the backend. Adds: `SetReportsTo` reaches the service, and `ReportsToCycle` arrives encoded.
- `plugins/org/renderer.test.tsx` (through `startRendererRegistry`): loading the org renderer adds key `{ plugin: 'org', id: 'org' }` to `PagesSlot` and `SettingsPagesSlot` and `{ plugin: 'org', id: 'org-settings' }` to `CommandsSlot`; unloading the plugin removes all three.
- `plugins/org/org-tree.test.ts`: no hires gives no nodes; hires with null `reportsTo` are roots ordered by `hiredAt`; a three-level chain nests; a hire whose `reportsTo` is missing is a root; hires with equal `hiredAt` keep the snapshot's order; `reportsToChoices` leaves out the hire itself and every hire below it, and keeps hires in other branches.
- `plugins/org/domain.test.ts`: `descendantsOf` returns every hire below `hireId` through any chain, leaves out `hireId`, and returns `[]` for a leaf.
- `plugins/org/org-view.test.ts`: a selected job title or hire still in the snapshot is kept; one no longer in it becomes null; `DashboardView` and `OrgChartView` are returned unchanged.
- `plugins/org/mcp-json.test.ts`: a stdio entry without `type` decodes as stdio; missing `args` / `env` / `headers` are filled; malformed JSON and the `mcpServers` wrapper are refused with a message; printing then parsing a job title's servers gives the same value.
- Org page component tests in `plugins/org/org-page.test.tsx` and `plugins/org/org-settings-page.test.tsx` (typechecked by `tsconfig.test.json`, as `plugins/adapters/adapter-settings.test.tsx` is), against fixture snapshots:
  - the page opens on Dashboard; each sub-navigation entry shows its page and its heading names it; `PluginNotServing` shows its `message`;
  - Dashboard shows the three stats; with no hires shows the no-hires item, and its `Hire…` opens the Hire dialog; with hires shows "Nothing needs attention."; `Change` opens Settings › Org;
  - Org chart draws a node under its manager, and selecting a node shows Hired agents with that agent selected;
  - Job titles list rows show name and hire count; `JobTitleNotFound` on `DeleteJobTitle` closes the dialog and re-reads; `JobTitleNotFound` on `EditJobTitle` shows `This job title was removed`; selecting one shows its enabled switch and its agents' names; `Delete…` appears only on copies, sends only after confirm, and `JobTitleHasHires` shows in the dialog; Copy and Edit send `CopyJobTitle` / `EditJobTitle`; a blank name sends nothing; `JobTitleNameTaken` shows under the name field; invalid MCP JSON shows its issue and sends nothing; a failed `SetJobTitleEnabled` shows an error toast titled `Could not disable <name>`;
  - Hired agents: Rename, Reports to and the bypass override each send their call; `Dismiss…` sends nothing before the confirm button, and its dialog names where the reports go; `HireNameTaken` shows under the name field; `ReportsToCycle` shows under Reports to with the self and the other copy, and the field keeps its value; `HireNotFound` for the `reportsTo` argument shows `The selected manager was dismissed` and re-reads; a failed `Dismiss` shows its reason in the dialog; a failed `SetBypassOverride` shows its toast; `Hire…` above the list opens the Hire dialog; the Reports to select leaves out the agent and its reports; a `HireNotFound` on `Dismiss` is treated as success and re-reads `ReadOrg`; a `HireNotFound` on `RenameHire` shows `This agent was dismissed` and re-reads; a dismissed selected agent selects the first agent;
  - Hire dialog: a blank name sends `name: null`; the chosen Reports to is sent as `reportsTo`; `Hire` is disabled until a job title is chosen; `JobTitleDisabled` shows under the Hire button; on success Hired agents shows with the new agent selected, set after the refresh resolves;
  - bypass controls are absent when `bypassAvailable` is false; `Initial` shows a skeleton and `Failure` shows the message with `Try again`.
- Org settings page: `0` and `1.5` show the error and send nothing; `6` sends `SetOverallCap { cap: 6 }` on blur and on Enter.

## Refinement Record

Rounds 1 to 3 and the revision after #204 are recorded in the version of this file before #209 (`git show 05804c7:docs/designs/org-screens.md`).

**Revision after #209 (2026-11-07)**

#209 (ADR-0064) renamed roles to job titles and instructions to job descriptions, replaced the built-in roles, and removed the first-run retro hire and the retro warning. This design was revised to match, and its sub-page decisions were written out: the Org page's four sub-pages, `OrgView`, `orgTree`, `reportsToChoices`, `needsAttention`, `setReportsTo`, and migration `4_add_reports_to`.

**Round 1 (after #209)**

Applied
- *Correctness, 1, 2, 3 (minor)*: citations corrected: `src/shared/plugin/plugin-registry.ts:845-851`, `src/renderer/src/lib/plugin-messages.ts:32`, and `permission-settings.ts:44` with `sdk.d.ts:3404-3412` for the settings sources.
- *Project rules, 4 (major)*: `OrgView` and `AttentionItem` are schemas with derived types, not hand-written types.
- *Project rules, 5 (major)*: the bypass caption matches `src/renderer/src/lib/permission-modes.ts:41`.
- *Correctness, 7 (minor)*: a resent named `Hire` can also fail with `HireNameTaken`.
- *Copy, 8 (minor)*: the `NoHires` text no longer names tasks, which do not exist until #179.
- *Information hiding, 9 (minor)*: the cycle rule is one function, `descendantsOf` in `domain.ts`, used by the service and `reportsToChoices`.
- *Project rules, 10 (minor)*: the other code that changes with `reportsTo` is listed.
- *Naming, 11 (minor)*: failure copy for a self-report and for a dismissed manager.
- *Tests, 12 (minor)*: foreign key check after `4_add_reports_to`; order of equal `hiredAt`. Changed from the finding: the renderer keeps the snapshot's order (`hired_at, rowid`, `org.ts:169`) instead of ordering by id.
- *Correctness, 13 (minor)*: MCP text decodes with `JobTitle.fields.mcpServers`.

Rejected
- *Project rules, 6 (major)* (a new ADR for `reportsTo`): root `CLAUDE.md` scopes ADRs to architecture (process model, framework, build tooling, styling, repo layout). `reportsTo` is a field of the org domain, and this spec records its rules.

**Round 2 (after #209)**

Applied
- *Correctness, 1 (blocker)*: a page cannot add breadcrumb items (`plugins/layout/layout.tsx:65-75`); the header reads `Org` and the page draws the sub-page heading.
- *Correctness, 2 (blocker)*: a newly hired agent is selected only after the refresh that contains it resolves.
- *Correctness, 3 (major)*: Hired agents has `Hire…`; the Hire dialog's blank job title state is stated.
- *Correctness, 4 (major)*: the not-found row excludes `Dismiss` and `DeleteJobTitle`.
- *Tests, 5 (major)*: `descendantsOf`, manager-dismissed copy, `PluginNotServing`, toasts, `reportsTo` sent, cycle copy, blur and Enter, and the test files named.
- *Define Errors Out of Existence, 6 (minor)*: idempotent `Dismiss` / `DeleteJobTitle` recorded as a rejected alternative.
- *Project rules, 7 (minor)*: `OrgNode` exported; JSDoc on every exported schema; renderer logging stated.
- *Naming, 8 (minor)*: view members end in `View`; `OrgView` lives in `useState`.

**Round 3 (after #209)**

Applied
- *Correctness, 1 (major)*: `Dismiss…` confirms, and names where the agent's reports go; re-hiring does not restore a name, override or reporting lines.
- *Correctness, 2 (minor)*: the agent-selecting paths are listed correctly; fix buttons open what fixes their item.
- *Minimize Complexity / AHA, 3 (minor)*: `attention.ts` dropped; the Dashboard checks for no hires itself, and #179 adds the union with its second item.
- *Correctness, 4 (minor)*: `setReportsTo` checks `hireId` first.
- *Tests, 5 (minor)*: `dismiss` of a hire that reports to the user.
- *Project rules, 6 (minor)*: import paths stated.

Round 3's one major finding is applied and the round budget (3) is spent, so the rounds end here.
