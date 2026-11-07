# Org screens (#178)

Scope: module. Adds the org's two screens: an **Org** page in the sidebar (roles and hired agents) and an **Org** page in the Settings dialog (the overall cap). To do that it adds two `Org` operations, `renameHire` and `setBypassOverride`; the org calls its host entry serves; and a renderer entry for `plugins/org` that adds a page to `PagesSlot` (ADR-0061), a page to `SettingsPagesSlot` and a search-only palette command (ADR-0063). The kernel does not change. Out of scope: objectives, tasks and the scheduler (#179 and later), a structured MCP server form (#197), model choice per role.

Decisions taken with the user in Understand (2026-11-07): the overall cap lives on a plugin Settings page (option C), built in this PR; bypass controls are hidden when managed or user Claude Code settings disable `bypassPermissions` (option A); MCP servers are edited as JSON (option A, #197 for a form); copied roles can be deleted.

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

Order 50 places Org after Meta repo (40). `OrgSettingsPage` takes `SettingsPageProps` and has no sections, so it ignores them. The Settings dialog draws the nav entry and breadcrumb, removes the page when the org plugin unloads, and shows `PluginFailed` if the page throws.

### Org service: `plugins/org/service.ts`

```ts
/** Renames hired agent `hireId` to `name`, or clears its name when null. */
readonly renameHire: (hireId: HireId, name: AgentName | null) => Effect<HiredAgent, HireNotFound | HireNameTaken>
/** Sets hired agent `hireId`'s bypass override: true or false overrides its role's `bypassOptIn`; null follows the role. */
readonly setBypassOverride: (hireId: HireId, override: boolean | null) => Effect<HiredAgent, HireNotFound>
```

Both run in one transaction in `plugins/org/org.ts`, as the other changes do: `renameHire` checks the name is free among other hires ignoring ASCII case (the same check as `hire`, excluding `hireId`), then writes. Each logs `Effect.logInfo` with the hire id. The `Org` interface's JSDoc (`plugins/org/service.ts`) gains a sentence for each.

### Org calls: `plugins/org/calls.ts`

Declared with `Rpc.make` (ADR-0057), each with a struct payload and a JSDoc line. No payload field is named `plugin`, `tag` or `payload` (the `CallPlugin` wrapper's fields, root `CLAUDE.md`).

| Tag | Payload | Success | Error |
| --- | --- | --- | --- |
| `ReadOrg` | `{}` | `OrgSnapshot` | none |
| `SetRoleEnabled` | `{ roleId, enabled }` | `Role` | `RoleNotFound` |
| `CopyRole` | `{ roleId, name: RoleName }` | `Role` | `RoleNotFound \| RoleNameTaken` |
| `EditRole` | `{ roleId, edit: RoleEdit }` | `Role` | `RoleNotFound \| RoleNameTaken \| BuiltInRoleRenamed` |
| `DeleteRole` | `{ roleId }` | `Void` | `RoleNotFound \| BuiltInRoleDeleted \| RoleHasHires` |
| `Hire` | `{ roleId, name: NullOr(AgentName) }` | `HiredAgent` | `RoleNotFound \| RoleDisabled \| HireNameTaken` |
| `Dismiss` | `{ hireId }` | `Void` | `HireNotFound` |
| `RenameHire` | `{ hireId, name: NullOr(AgentName) }` | `HiredAgent` | `HireNotFound \| HireNameTaken` |
| `SetBypassOverride` | `{ hireId, override: NullOr(Boolean) }` | `HiredAgent` | `HireNotFound` |
| `SetOverallCap` | `{ cap: OverallCap }` | `OrgSettings` | none |

ADR-0057 allows a call to be resent while the Host connection is down, so a handler can run more than once (`docs/adr/0057-plugin-pages-and-plugin-messages.md:45`). `SetRoleEnabled`, `EditRole`, `RenameHire`, `SetBypassOverride` and `SetOverallCap` set a value and are safe to repeat. `Dismiss` and `DeleteRole` fail with `HireNotFound` / `RoleNotFound` on a repeat; the renderer treats that error as success for these two calls and refreshes `orgAtom`. `Hire` with a null name and `CopyRole` are not safe to repeat: a resent call can add a second hire, or fail with `RoleNameTaken` after the first copy succeeded. This is accepted; the user removes a duplicate with `Dismiss` or `Delete…`.

```ts
/**
 * What the org screens show: every role, every hired agent, the org settings, and whether any
 * session could start in `bypassPermissions` (false when managed or user Claude Code settings
 * disable it, ADR-0054).
 */
export const OrgSnapshot = Schema.Struct({
  roles: Schema.Array(Role),
  hiredAgents: Schema.Array(HiredAgent),
  settings: OrgSettings,
  bypassAvailable: Schema.Boolean
})
```

`plugins/org/plugin.json` lists `calls.ts` in `exports` (ADR-0059), and `tsconfig.plugin-exports.json` and `tsconfig.web.json` include it. `calls.ts` imports the org schemas from `./domain` and `AgentName` from `@dia/plugin`. `host.ts` and the renderer files import the calls from `./calls`.

### `plugins/org`

| File | Change |
| --- | --- |
| `plugin.json` | `"renderer": "renderer.ts"`, `"load": "eager"`, `calls.ts` added to `exports`; `api` stays `0.0.27`. No `inject`: an `inject` key without a provider puts the plugin in `Waiting` (`plugin-registry.ts:786-790`), and the renderer registry reads the same manifest with no provider of `agentBackend` |
| `host.ts` | after providing `OrgService`, `ctx.serve` each call. `ReadOrg` reads `roles`, `hiredAgents`, `settings` and `bypassAvailable`; these are separate reads, not one transaction, so a change landing between them shows after the next refresh, which every change triggers. A `Ref<Option<AgentBackend>>` is set and cleared by `ctx.whenProvided([AgentBackendKey], ({ agentBackend }) => Effect.acquireRelease(Ref.set(ref, Option.some(agentBackend)), () => Ref.set(ref, Option.none())))` (ADR-0056); `AgentBackendKey` types `agentBackend` as `AgentBackend` |
| `bypass.ts` | `bypassAvailable(ref)`: while the ref is empty it returns `false` and logs at debug level (no session can start without a backend; the controls appear on the next read after a backend is provided); otherwise `!(yield* backend.disabledPermissionModes(homedir())).includes('bypassPermissions')`. `homedir` is imported from `node:os` with `// @effect-diagnostics-next-line nodeBuiltinImport:off -- <reason>`, as `plugins/claude-code/attachments.ts:1` does. The claude-code backend calls `resolveSettings({ cwd })` with every source (`permission-settings.ts:50`); `cwd` only locates project and local settings, and managed and user settings are always read (`sdk.d.ts:3403-3412`, SDK 0.3.311). At the home directory the project file `~/.claude/settings.json` is the user settings file; other directories' project and local settings are not read, which ADR-0054's per-session check covers |
| `renderer.ts` | `addEntry(ctx, PagesSlot, { id: 'org', order: 10, label: 'Org', icon: UsersIcon, component })`, the Settings page and the palette command above; one `orgAtom = Atom.make(callHost(ctx, ReadOrg, {}))` shared by both pages |
| `org-page.tsx` | roles and hired agents, the retro warning |
| `role-editor.tsx` | the role edit form |
| `org-settings-page.tsx` | the overall cap |
| `mcp-json.ts` | turns the MCP textarea text into `RoleEdit.mcpServers`, and a role's servers back into text; added to `tsconfig.web.json`'s `include` |

`renderer.ts` passes `ctx` and `orgAtom` to both page components by closure with `createElement`, because `Page.component` takes no props and `SettingsPage.component` takes only `SettingsPageProps` (`plugins/example/renderer.ts`).

`@dia/renderer-plugin` already exports `Skeleton`, `ToggleGroup` and `Empty` (#208). `src/renderer/src/plugin-api.ts` also exports any shadcn component the `/impeccable` design adds, installed through the `shadcn` skill.

Renderer helpers are `.tsx` files or are added to `tsconfig.web.json`'s `include` (it lists `plugins/**/renderer.ts`, `plugins/**/*.tsx` and named `.ts` files).

### Renderer behaviour

- Reads: both pages read `orgAtom` (`AsyncResult`): `Initial` shows a skeleton, `Failure` shows the error message in error red with `Try again`, `Success` shows the screen. A refresh (`useAtomRefresh`, `@effect/atom-react`) keeps showing the last snapshot until the new one arrives. When neither page has read the atom for 400 ms (`appRegistry`'s `defaultIdleTTL`, `workspace-atoms.ts:21`), the next open reads again. A backend provided after a read does not refresh an open page; the next change or reopen reads `bypassAvailable` again (the org and adapter plugins are both eager, so this happens only during startup).
- Changes: each change runs `callHost(ctx, <Call>, payload)`. On success the page refreshes `orgAtom`.
- Name inputs: role, hire and rename inputs are trimmed and decoded with `RoleName` / `AgentName` before any call, because `callHost` runs `payloadSchema.make` (`plugin-messages.ts:32`), which throws on an invalid branded value. A blank hire or rename input becomes `null`. A blank role name, or a name over the maximum length, shows its message beside the field and sends nothing.
- Failures (`Schema.TaggedError` classes carry no message text, so the screen supplies the copy):

  | Call | Shown where | Text |
  | --- | --- | --- |
  | `CopyRole`, `EditRole` | under the name field | `A role named "<name>" already exists` (`RoleNameTaken`); `A built-in role keeps its name` (`BuiltInRoleRenamed`) |
  | `Hire`, `RenameHire` | under the name field | `An agent named "<name>" already exists` (`HireNameTaken`) |
  | `Hire` | under the Hire button | `This role is disabled` (`RoleDisabled`) |
  | `DeleteRole` | in the delete dialog | `Dismiss its <n> hired agents first` (`Dismiss its hired agent first` when 1) (`RoleHasHires`) |
  | `SetRoleEnabled`, `Dismiss`, `SetBypassOverride`, `Hire retro` | error toast (DESIGN.md › Toast) | title `Could not <action> <name>`, the reason as description |
  | any | as the call's row above, or a toast | `RoleNotFound` / `HireNotFound`: `This role was removed` / `This agent was dismissed`, and `orgAtom` is refreshed because the screen is out of date |
  | any | as the call's row above, or a toast | `PluginNotServing` / `PluginCallInvalid`: their `message` |
- Role edit form fields: name (copies only; a built-in role's name is read-only), instructions (textarea), skills (one name per line, mono), allow / ask / deny (one rule per line each, mono), MCP servers, bypass opt-in (switch, hidden when `bypassAvailable` is false, with the caption `Skips approvals only when auto mode is unavailable`, ADR-0054).
- MCP servers field (`mcp-json.ts`): a mono textarea holding the record `{ "<server>": { ... } }`, not the `{ "mcpServers": ... }` wrapper. The text is parsed with `Schema.fromJsonString` (the `preferSchemaOverJson` diagnostic is a warning, `tsconfig.base.json:32`). Before decoding, an entry without `type` that has `command` gets `type: 'stdio'`; a stdio entry missing `args` or `env` gets `[]` / `{}`; an http or sse entry missing `headers` gets `{}`. It is then decoded with `Schema.Record(Schema.String, RoleMcpServer)`. A JSON syntax error or the first schema issue shows in error red and nothing is sent. Keys the schema does not know are dropped; after a save the textarea shows the saved value.
- Hired agent row: name (or `Unnamed <role>`), role, `Rename`, the bypass override (`Follow role` / `On` / `Off`, hidden when `bypassAvailable` is false), `Dismiss`, which runs at once with no confirmation, as Unarchive does: a dismissed hire is re-created with `Hire…`.
- Role row: name, `Built in` caption on built-in roles, hire count, enabled switch, menu with `Edit`, `Copy…`, `Hire…`, and `Delete…` on copies only. `Delete…` opens an alert dialog naming the role; the role is deleted only on its confirm button.
- Retro warning: while no hired agent's role has `builtIn === 'retro'` (a hire of a copy of retro does not count), an amber-marked line above the lists: "No retro is hired. Finished tasks wait until one is." with `Hire retro`. When the retro role is disabled it reads "No retro is hired and the retro role is disabled." with `Enable retro`.
- Org settings page: "Hired agents running at once" number input, min 1, step 1, saved on blur or Enter; an invalid value shows "Enter a whole number of 1 or more" in error red and is not sent.

The screens' visual design is made with `/impeccable` against fixture `OrgSnapshot` values and passes its finish review against `DESIGN.md` before `orgAtom` reads real data (issue #178).

## Key Data Structures

`OrgSnapshot` (above). Every other type is existing (`Role`, `HiredAgent`, `OrgSettings`, `RoleEdit`, the org errors, `Page`, `SettingsPage`, `CommandEntry`).

## Internal Decomposition

- **`plugins/org/calls.ts`** — owns the wire contract between the org plugin's two entries.
- **`plugins/org/host.ts`** — owns serving the calls and holding the agent backend while it is provided.
- **`plugins/org/bypass.ts`** — owns deciding whether bypass is available.
- **`plugins/org/mcp-json.ts`** — owns the MCP servers text format: parsing, filling defaults, decoding, and printing a role's servers; the role editor knows neither the fill rules nor the JSON shape.
- **`plugins/org` renderer files** — own the screens; they know the calls, never the `Org` service.

## Design Rationale

**The agent backend through `whenProvided`** — the org works without a backend (only `bypassAvailable` uses it), which is the case ADR-0056 covers; `inject` would stop the whole plugin, and its renderer entry, until a backend is provided.

**Call declarations in an exported plugin module** — since #207 the org schemas live in `plugins/org/domain.ts`, and an exported module resolves `@dia/plugin` in both the Host and the renderer build (ADR-0059). The calls sit beside the schemas in `plugins/org/calls.ts`, so the kernel holds no org contract.

**One `ReadOrg` snapshot** — both pages need the same data, and a change can affect several parts (deleting a copy changes the role list; hiring changes a role's count), so the renderer refreshes one value after every change instead of patching parts.

**`bypassAvailable` at the home directory** — chosen with the user (option A): the org spans every project, and ADR-0054's per-session check still reads each project's settings.

**Eager load** — a lazy host entry can serve `ReadOrg` after the page's first call, which would then show `PluginNotServing` during startup (ADR-0027).

## Rejected Alternatives

- **Org settings in the Org page header, or as a second sidebar page** — rejected by the user in Understand.
- **Structured MCP form** — deferred to #197.
- **Calls in `src/shared/domain`** — #207 moved the org domain out of the kernel; calls there would bring an org contract back into it.
- **A kernel `addSettingsPage`** (the first version of this design, never merged) — replaced by `SettingsPagesSlot` in #204 (ADR-0063).

## ADR and versions

- No new ADR: Settings pages and palette commands follow ADR-0063, exported modules ADR-0059.
- `PLUGIN_API_VERSION` stays `0.0.27`: the kernel API does not change. `PROTOCOL_VERSION` is unchanged: `DiaRpcs` does not change.

## Tests

- `plugins/org/org.test.ts`: `renameHire` (rename, clear, clash ignoring case refused, own name recased allowed, unknown id refused); `setBypassOverride` (true, false, null; unknown id refused); an `editRole`, a `renameHire` and a `setOverallCap`, then the org reopened on the same temp-file database, still hold (criteria 3, 5, 7 "after a restart").
- `plugins/org/host.test.ts` (calls through a real registry, as `plugin-messages.test.ts` does): `ReadOrg` returns the seeded snapshot; one change per call reaches the service; `bypassAvailable` is false with no backend, true with a backend whose `disabledPermissionModes` omits `bypassPermissions`, false with one that contains it, and changes when a backend is provided or withdrawn after setup.
- `plugins/org/renderer.test.ts` (criterion 9, through `startRendererRegistry`): loading the org renderer adds key `{ plugin: 'org', id: 'org' }` to `PagesSlot` and `SettingsPagesSlot` and `{ plugin: 'org', id: 'org-settings' }` to `CommandsSlot`; unloading the plugin removes all three.
- `plugins/org/mcp-json.test.ts`: a stdio entry without `type` decodes as stdio; missing `args` / `env` / `headers` are filled; malformed JSON and the `mcpServers` wrapper are refused with a message; printing then parsing a role's servers gives the same value.
- Org page component tests, against fixture snapshots: role rows show name, hire count and enabled switch, hire rows show name or `Unnamed <role>` and role (criterion 1); a disabled role shows disabled and a `RoleDisabled` failure shows under Hire (2); Rename, Dismiss and the bypass override each send their call (5); `HireNameTaken` and `RoleNameTaken` show under the name field (5, 3); Delete appears only on copies, sends only after the confirm click, and `RoleHasHires` shows in the dialog (4); the retro warning shows with no retro hired, not with one, and reads the disabled variant when retro is disabled (6); bypass controls absent when `bypassAvailable` is false (8); invalid MCP JSON shows its issue and sends nothing (3); a blank hire name sends `name: null`; Copy and Edit send `CopyRole` / `EditRole`, and a blank role name sends nothing; a failed `SetRoleEnabled` shows an error toast titled `Could not disable <name>` with the reason; a `HireNotFound` on `Dismiss` is treated as success and re-reads `ReadOrg`; a `HireNotFound` on `RenameHire` shows `This agent was dismissed` and re-reads; `Enable retro` sends `SetRoleEnabled { enabled: true }`; `Initial` shows a skeleton and `Failure` shows the message with `Try again`.
- Org settings page: `0` and `1.5` show the error and send nothing; `6` sends `SetOverallCap { cap: 6 }` (7).

## Refinement Record

**Round 1**

Applied
- *Correctness, 1 (blocker)*: `"inject": ["agentBackend"]` would leave the plugin `Waiting` (`plugin-registry.ts:786-790`) and its renderer entry with no provider; the backend is now held through `ctx.whenProvided` (ADR-0056).
- *Project rules, 2*: `node:os` triggers the `nodeBuiltinImport` warning (`tsconfig.base.json:31`); the import carries the suppression the claude-code plugin uses.
- *Correctness, 3*: the home-directory reading of `resolveSettings` is marked unverified.
- *Correctness, 4*: the rationale for `src/shared/domain/org-calls.ts` now names both resolution limits.
- *Simplicity, 5*: `asAgentBackend` removed; `adapterContract` already validates the backend.
- *Correctness, 6*: `noRegistryInject` covers only `**/src/**` (`biome.json:15-16`); the parenthetical is removed.
- *Correctness, 8*: nav highlight, breadcrumb and body read the derived `shown`; breadcrumb items are keyed by index.
- *Correctness, 9*: refresh and idle-TTL behaviour stated.
- *Correctness, 10*: `ReadOrg` is stated as separate reads.
- *Project rules, 11*: JSDoc and logging stated for the new exports.
- *AHA, 12*: no shared `scopedEntries` helper.
- *Project rules, 13*: renderer helpers are `.tsx` or added to `tsconfig.web.json`.
- *Naming, 14*: `PageKey`'s JSDoc names both functions.

Rejected
- *Project rules, 7* (the retro warning states behaviour that does not exist): ADR-0033 › Scheduling states "While `retro` has no hired agent, the org screen shows a warning and finished tasks wait for a retro" (`docs/adr/0033-one-org-of-hired-role-agents.md:48`); the warning states that rule.

**Round 2**

Applied
- *Correctness, 1 (major)*: the MCP text format is defined: the record without the `mcpServers` wrapper, `type` defaulting to stdio when `command` is present, per-type defaults, unknown keys dropped.
- *Project rules, 2 (major)*: parsing uses `Schema.fromJsonString` (`preferSchemaOverJson` is a warning, `tsconfig.base.json:32`); `mcp-json.ts` added and included in `tsconfig.web.json`.
- *Correctness, 3 (major)*: name inputs are decoded before a call, because `payloadSchema.make` throws on an invalid branded value (`plugin-messages.ts:32`); blank hire names become `null`.
- *Correctness, 4 (major)*: `Skeleton` and `ToggleGroup` are added to `@dia/renderer-plugin`; any shadcn component the design adds goes through the `shadcn` skill. The finding's `dropdown-menu` was not taken as given: the design step chooses the row-menu component. `ctx` and `orgAtom` reach the pages by closure.
- *Correctness, 5 (major)*: every call's failure has a place and copy; failures with no field use an error toast (DESIGN.md › Toast); not-found errors refresh `orgAtom`.
- *Project rules, 6 (major)*: tests added for criteria 1-9, including reopen-after-restart, renderer scope close, backend arriving after setup, and MCP parsing.
- *Correctness, 7*: `bypassAvailable` is `false` while no backend is provided, logged at debug.
- *Correctness, 8*: retro warning edge cases (copies do not count; disabled retro variant).
- *Correctness, 9*: `NavItem.page` excludes `plugin`.
- *Information hiding, 10*: `mcp-json.ts` owns the text format; Dismiss runs at once; the bypass caption names ADR-0054's condition.
- *Correctness (no number)*: the home-directory claim now cites `sdk.d.ts:3403-3412` instead of being marked unverified.

**Round 3**

Applied
- *Correctness, 1 (major)*: resent calls (ADR-0057:45): set-value calls are safe to repeat; a not-found error on a repeated `Dismiss` / `DeleteRole` is treated as success; a duplicate from a resent `Hire` with no name or `CopyRole` is accepted and stated.
- *Project rules, 2*: tests added for the toast, not-found handling, `Enable retro`, loading and failure states, role-name validation, and Copy / Edit calls.
- *Information hiding, 3*: a backend provided after a read does not refresh an open page; stated.

Round 3's one major finding is applied and the round budget (3) is spent, so the rounds end here.

**Revision after #204 (2026-11-07)**

#204 replaced the kernel Settings dialog with the `settings` plugin and its `SettingsPagesSlot` (ADR-0063), and #207 moved the org domain into `plugins/org`. This design was revised to match: the `addSettingsPage` extension point and its planned ADR are dropped; the Org Settings page and its palette command are entries in `SettingsPagesSlot` and `CommandsSlot`; the sidebar page is an entry in `PagesSlot`; the calls move from `src/shared/domain/org-calls.ts` to the exported module `plugins/org/calls.ts`; the host entry uses `OrgService` and `AgentBackendKey`. The kernel no longer changes, so `PLUGIN_API_VERSION` is not bumped.
