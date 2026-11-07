# Org screens (#178)

Scope: module. Adds the org's two screens: an **Org** page in the sidebar (roles and hired agents) and an **Org** page in the Settings dialog (the overall cap). To do that it adds a kernel extension point, `addSettingsPage`; two `Org` operations, `renameHire` and `setBypassOverride`; a renderer entry for `plugins/org`; and the org calls its host entry serves. Out of scope: objectives, tasks and the scheduler (#179 and later), a structured MCP server form (#197), model choice per role.

Decisions taken with the user in Understand (2026-11-07): the overall cap lives on a plugin Settings page (option C), built in this PR; bypass controls are hidden when managed or user Claude Code settings disable `bypassPermissions` (option A); MCP servers are edited as JSON (option A, #197 for a form); copied roles can be deleted.

## Interface

### Kernel: `src/renderer/src/lib/settings-pages.ts` (exported from `@dia/renderer-plugin`)

```ts
/** A page a plugin adds to the Settings dialog with {@link addSettingsPage}. */
export interface SettingsPage {
  /** Unique within the plugin, for example `org`. */
  readonly id: string
  /** The nav entry's text and the last breadcrumb item, for example `Org`. */
  readonly label: string
  /** The nav entry's icon. */
  readonly icon: ComponentType<{ readonly className?: string }>
  /** Sort position after the built-in pages; lower first. Ties keep the order pages were added. */
  readonly order: number
  /** Renders the page body; the dialog draws the nav and breadcrumb. */
  readonly component: ComponentType
}

/** A {@link SettingsPage} with the plugin name and id that identify it. */
export interface RegisteredSettingsPage extends SettingsPage {
  readonly key: PageKey
}

/**
 * Adds `page` to the Settings dialog's nav, after Meta repo, for as long as the plugin's scope is
 * open. Its key is the plugin's name and `page.id`; adding a key again replaces the earlier entry.
 * When the scope closes the page is removed, and a dialog showing it shows General. Call it from a
 * renderer plugin's setup.
 */
export const addSettingsPage: (ctx: PluginServices, page: SettingsPage) => Effect<void, never, Scope>

/** Every Settings page plugins added, sorted by `order`. Re-renders when one is added or removed. */
export function useSettingsPages(): ReadonlyArray<RegisteredSettingsPage>
```

`SettingsLocation` (`components/settings/open-settings.ts`) gains `{ readonly page: 'plugin'; readonly key: PageKey }`, so `openSettings({ page: 'plugin', key: { plugin: 'org', id: 'org' } })` opens it.

`SettingsDialog` renders the built-in `NAV_ITEMS`, then `useSettingsPages()` in the same `SidebarMenu`. The dialog computes `shown` from `location` and `useSettingsPages()`: a `plugin` location whose key no registered page has is shown as General, so a removed page needs no listener. The nav highlight (`isActive`), the breadcrumb and the page body all read `shown`; a plugin page's breadcrumb label is its registered `label`, so the breadcrumb is `Settings › <label>`. Breadcrumb items are keyed by index, so a plugin label equal to `Settings` does not collide. `NavItem.page` becomes `Exclude<SettingsLocation['page'], 'plugin'>`. `CommandPalette` appends one link per registered page, `Settings › <label>`, to `SETTINGS_PAGE_LINKS`, with the label as its only keyword.

`settings-pages.ts` repeats `addPage`'s acquire and release (`lib/pages.ts`): adding replaces an entry with the same key and sorts by `order`; release removes that exact entry by identity, so a reload that added the key again keeps the new entry. A shared helper waits for a third list. `addSettingsPage` logs `Effect.logDebug('Added a settings page' / 'Removed a settings page', { plugin, id })`, as `addPage` does (`pages.ts:56`, `:75`). `PageKey`'s JSDoc (`lib/view.ts`) names both `addPage` and `addSettingsPage`. Every new export carries JSDoc.

### Org service: `src/host/services/org-seam.ts`

```ts
/** Renames hired agent `hireId` to `name`, or clears its name when null. */
readonly renameHire: (hireId: HireId, name: AgentName | null) => Effect<HiredAgent, HireNotFound | HireNameTaken>
/** Sets hired agent `hireId`'s bypass override: true or false overrides its role's `bypassOptIn`; null follows the role. */
readonly setBypassOverride: (hireId: HireId, override: boolean | null) => Effect<HiredAgent, HireNotFound>
```

Both run in one transaction in `plugins/org/org.ts`, as the other changes do: `renameHire` checks the name is free among other hires ignoring ASCII case (the same check as `hire`, excluding `hireId`), then writes. Each logs `Effect.logInfo` with the hire id. The `Org` interface's JSDoc (`org-seam.ts:20-30`) gains a sentence for each.

### Org calls: `src/shared/domain/org-calls.ts`

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

`src/host/plugin-api.ts` re-exports every call and `OrgSnapshot`, so `plugins/org/host.ts` imports them from `@dia/plugin`; `plugins/org/renderer.ts` imports them from `@shared/domain/org-calls`, as renderer plugins import other shared schemas (`plugins/agent-overview/overview.ts:7-10`).

### `plugins/org`

| File | Change |
| --- | --- |
| `plugin.json` | `"renderer": "renderer.ts"`, `"load": "eager"`, `api` bumped. No `inject`: an `inject` key without a provider puts the plugin in `Waiting` (`plugin-registry.ts:786-790`), and the renderer registry reads the same manifest with no provider of `agentBackend` |
| `host.ts` | after providing `ORG_KEY`, `ctx.serve` each call. `ReadOrg` reads `roles`, `hiredAgents`, `settings` and `bypassAvailable`; these are separate reads, not one transaction, so a change landing between them shows after the next refresh, which every change triggers. A `Ref<Option<AgentBackend>>` is set and cleared by `ctx.whenProvided([AGENT_BACKEND_KEY], ({ agentBackend }) => Effect.acquireRelease(Ref.set(ref, Option.some(agentBackend as AgentBackend)), () => Ref.set(ref, Option.none())))` (ADR-0056); the cast is safe because `adapterContract` refuses an invalid backend (`agent-backend.ts:343-349`) |
| `bypass.ts` | `bypassAvailable(ref)`: while the ref is empty it returns `false` and logs at debug level (no session can start without a backend; the controls appear on the next read after a backend is provided); otherwise `!(yield* backend.disabledPermissionModes(homedir())).includes('bypassPermissions')`. `homedir` is imported from `node:os` with `// @effect-diagnostics-next-line nodeBuiltinImport:off -- <reason>`, as `plugins/claude-code/attachments.ts:1` does. The claude-code backend calls `resolveSettings({ cwd })` with every source (`permission-settings.ts:50`); `cwd` only locates project and local settings, and managed and user settings are always read (`sdk.d.ts:3403-3412`, SDK 0.3.311). At the home directory the project file `~/.claude/settings.json` is the user settings file; other directories' project and local settings are not read, which ADR-0054's per-session check covers |
| `renderer.ts` | `addPage(ctx, { id: 'org', label: 'Org', icon: UsersIcon, order: 10, component })` and `addSettingsPage(ctx, { id: 'org', label: 'Org', icon: UsersIcon, order: 10, component })`; one `orgAtom = Atom.make(callHost(ctx, ReadOrg, {}))` shared by both pages |
| `org-page.tsx` | roles and hired agents, the retro warning |
| `role-editor.tsx` | the role edit form |
| `org-settings-page.tsx` | the overall cap |
| `mcp-json.ts` | turns the MCP textarea text into `RoleEdit.mcpServers`, and a role's servers back into text; added to `tsconfig.web.json`'s `include` |

`renderer.ts` passes `ctx` and `orgAtom` to both page components by closure with `createElement`, because `Page.component` and `SettingsPage.component` take no props (`plugins/example/renderer.ts`).

`src/renderer/src/plugin-api.ts` also exports `Skeleton` (`components/ui/skeleton.tsx`, installed but not exported today) and `ToggleGroup` (`components/ui/toggle-group.tsx`), and any shadcn component the `/impeccable` design adds, installed through the `shadcn` skill.

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

`OrgSnapshot` (above). `SettingsLocation`'s new `plugin` member. Every other type is existing (`Role`, `HiredAgent`, `OrgSettings`, `RoleEdit`, the org errors, `PageKey`).

## Internal Decomposition

- **`lib/settings-pages.ts`** — owns the Settings page list and its hook.
- **`src/shared/domain/org-calls.ts`** — owns the wire contract between the org plugin's two entries.
- **`plugins/org/host.ts`** — owns serving the calls and holding the agent backend while it is provided.
- **`plugins/org/bypass.ts`** — owns deciding whether bypass is available.
- **`plugins/org/mcp-json.ts`** — owns the MCP servers text format: parsing, filling defaults, decoding, and printing a role's servers; the role editor knows neither the fill rules nor the JSON shape.
- **`plugins/org` renderer files** — own the screens; they know the calls, never the `Org` service.

## Design Rationale

**Settings pages as a second kernel list, like `addPage`** — a Settings page and a content page share key, scope lifetime and order rules (ADR-0057), so the same shape is used. The two lists' acquire and release are written twice rather than through a helper, because `addPage`'s release also closes the open page and two uses do not yet show what a helper should cover.

**The agent backend through `whenProvided`** — the org works without a backend (only `bypassAvailable` uses it), which is the case ADR-0056 covers; `inject` would stop the whole plugin, and its renderer entry, until a backend is provided.

**Derived fallback to General** — the dialog computes what it shows from the location and the registered pages, so a page removed while shown needs no cleanup code and cannot leave the dialog on a missing page.

**Call declarations in `src/shared`** — a plugin-local `messages.ts` cannot serve both entries: the Host's resolve hook maps only `effect` and `@dia/plugin` (`plugin-modules.ts:92-110`), and the renderer build has no `@dia/plugin` alias (`electron.vite.config.ts:35-39`), so a module shared by both entries may import only `effect` and cannot reach `Role` or the org errors (`plugins/example/messages.ts` works because it imports only `effect`). The precedent is #177, which put the org's schemas and `Org` contract in the kernel and re-exported them.

**One `ReadOrg` snapshot** — both pages need the same data, and a change can affect several parts (deleting a copy changes the role list; hiring changes a role's count), so the renderer refreshes one value after every change instead of patching parts.

**`bypassAvailable` at the home directory** — chosen with the user (option A): the org spans every project, and ADR-0054's per-session check still reads each project's settings.

**Eager load** — a lazy host entry can serve `ReadOrg` after the page's first call, which would then show `PluginNotServing` during startup (ADR-0027).

## Rejected Alternatives

- **Org settings in the Org page header, or as a second sidebar page** — rejected by the user in Understand.
- **Structured MCP form** — deferred to #197.
- **A plugin-local `messages.ts`** — the Host cannot resolve its `@shared` imports (above).

## ADR and versions

- New ADR-0058, "Let a renderer plugin add pages to the Settings dialog", amending ADR-0031; ADR-0031's status adds ADR-0058. DESIGN.md › Navigation names plugin Settings pages.
- `PLUGIN_API_VERSION` 0.0.22 → 0.0.23, and every `plugins/*/plugin.json` `api`. `PROTOCOL_VERSION` is unchanged: `DiaRpcs` does not change.

## Tests

- `lib/settings-pages.test.ts`: sorted by order; ties in add order; removed when the scope closes; a reload that adds the key before the old scope closes keeps the page.
- `settings-dialog.test.tsx`: a plugin page appears after Meta repo and shows its component and breadcrumb; a `plugin` location whose page is removed shows General.
- `command-palette.test.tsx`: a registered page's link opens `{ page: 'plugin', key }`.
- `plugins/org/org.test.ts`: `renameHire` (rename, clear, clash ignoring case refused, own name recased allowed, unknown id refused); `setBypassOverride` (true, false, null; unknown id refused); an `editRole`, a `renameHire` and a `setOverallCap`, then the org reopened on the same temp-file database, still hold (criteria 3, 5, 7 "after a restart").
- `plugins/org/host.test.ts` (calls through a real registry, as `plugin-messages.test.ts` does): `ReadOrg` returns the seeded snapshot; one change per call reaches the service; `bypassAvailable` is false with no backend, true with a backend whose `disabledPermissionModes` omits `bypassPermissions`, false with one that contains it, and changes when a backend is provided or withdrawn after setup.
- `plugins/org/renderer.test.ts` (criterion 9): running the renderer setup in a scope adds key `{ plugin: 'org', id: 'org' }` to both `pagesAtom` and the settings page list; closing the scope removes both.
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
