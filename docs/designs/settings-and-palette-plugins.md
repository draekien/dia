# Settings, command palette and dialogs as plugins (issue #204)

## Purpose

Move the Settings dialog and the command palette out of the kernel into plugins, so that a plugin can add a Settings page, an adapter settings panel or a palette command with `addEntry` (ADR-0061), and the entry is removed when that plugin's renderer entry unloads.

## Scope

- In: `layout`'s `DialogsSlot`; new plugins `settings`, `command-palette`, `adapters`, `claude-code-settings`; a `renderer.ts` for `meta`; `SettingsLocation`; the kernel exports the moved code needs; an ADR amending ADR-0031.
- Set `PLUGIN_API_VERSION` to `0.0.27` in `src/shared/plugin/manifest.ts` and `"api": "0.0.27"` in every `plugins/*/plugin.json`, existing and new.
- Out: making Settings › Plugins › Unload stop a renderer entry (reasoning `2026-11-07-settings-unload-keeps-renderer-entry.md`); a list slot for General rows; #178's org page.
- In: a kernel `PluginBoundary` around every component a plugin supplies, at every site that draws one (see Error handling), including sites that exist before this change.
- Consequence: with no `layout` plugin loaded (the `NoLayoutPlugin` fallback) there is no Settings dialog and no palette, and reloading `layout` closes an open dialog.

## Slots

| Slot | Name | Module (exported, ADR-0059) | Owner draws | Entry type |
| --- | --- | --- | --- | --- |
| `DialogsSlot` | `layout.dialogs` | `plugins/layout/slots.ts` | `Layout` | `DialogEntry { id, order, component: ComponentType }` |
| `SettingsPagesSlot` | `settings.pages` | `plugins/settings/slots.ts` | The Settings dialog's nav and the selected page | `SettingsPage { id, order, label, icon: ComponentType<{ readonly className?: string }>, component: ComponentType<SettingsPageProps> }` |
| `CommandsSlot` | `command-palette.commands` | `plugins/command-palette/slots.ts` | The palette's groups and items | `CommandEntry { id, order, group, label, icon?: ComponentType<{ readonly className?: string }>, keywords?, searchOnly?, run: () => void }`; an entry with `searchOnly: true` is listed only while the query is not empty |
| `AdapterPanelsSlot` | `adapters.panels` | `plugins/adapters/slots.ts` | The Adapters page's selected adapter | `AdapterPanel { id, order, label, component: ComponentType, statusLine: ComponentType }`; `id` is the name of the adapter plugin the panel configures; `order` is unused because adapter rows follow `usePluginList` |

`SettingsPageProps` is `{ readonly requestedSection: string | undefined; readonly lastSection: string | undefined; readonly onSectionShown: (section: SettingsSection | undefined) => void }`, where `SettingsSection` is `{ readonly id: string; readonly label: string }`; `plugins/settings/slots.ts` exports both. `requestedSection` is the section the page should show: the `section` of the location the dialog was opened with, replaced by each `id` the page reports through `onSectionShown`, and set to `undefined` when the dialog opens on this page with a location that has no `section`. `lastSection` is the `id` this page last reported. A page calls `onSectionShown` whenever the section it shows changes; a row click calls it directly. These mirror today's `AdapterSettings` props `requested` and `lastViewed`.

`icon` uses the type of `Page.icon` in `plugins/layout/slots.ts`. No entry type declares `key`: `useList` returns each entry with `key: { plugin, id }` (`ListEntryFields` reserves `key?: never`).

Each `slots.ts` imports only `@dia/plugin` (`ListSlot`) and type-only `react`, and is added to `exports` in its `plugin.json` and to `tsconfig.plugin-exports.json` and `tsconfig.web.json`.

`Layout` (`plugins/layout/layout.tsx`) returns `<><SidebarProvider>…</SidebarProvider>{dialogs.map((d) => <d.component key={`${d.key.plugin}/${d.key.id}`} />)}</>` where `dialogs = useList(DialogsSlot)`.

## Kernel

| Module | After |
| --- | --- |
| `components/settings/open-settings.ts` | `SettingsLocation = { readonly plugin: string; readonly id: string; readonly section?: string }`; `openSettings(location?)` and `OPEN_SETTINGS_EVENT` otherwise unchanged. Adds `CLAUDE_CODE_SETTINGS`, exported through `@dia/renderer-plugin`. |
| `components/open-command-palette.ts` (new, dependency-free) | `openCommandPalette()` and `OPEN_COMMAND_PALETTE_EVENT`, moved out of `command-palette.tsx`; `window-status.tsx` imports it. |
| `lib/plugin-status-label.ts` (new) | `pluginStatusLabel(status: PluginStatus)`, today `statusLabel` in `plugin-settings.tsx`; used by `settings` (Plugins page) and `adapters`. `statusLabel` in `status-indicator.tsx` is the agent status and keeps its name. |
| `components/settings-section.tsx` | Today `components/settings/section.tsx`; exports `SettingsSectionHeading` and `SettingsRow`, because `meta` and `claude-code-settings` both use them and an exported plugin module cannot hold a component. |
| `components/about-dialog.tsx` | Unchanged; stays in `src/` because it imports `brand/*.svg`. |
| `main.tsx` | No longer mounts `<CommandPalette />` or `<SettingsDialog />`. |
| `components/settings/*` except `open-settings.ts` and `section.tsx`; `components/command-palette.tsx` | Moved to the plugins below and deleted from `src/`. |
| `lib/actions.ts` | `openPluginsPage` calls `openSettings({ plugin: 'settings', id: 'plugins' })`. |
| `components/install-notice.tsx` | Calls `openSettings(CLAUDE_CODE_SETTINGS)` (see Callers). |

`@dia/renderer-plugin` (`src/renderer/src/plugin-api.ts`) adds, and nothing else:

- Values: `PluginBoundary`, `PluginFailed`, `openCommandPalette`, `AboutDialog`, `SettingsSectionHeading`, `SettingsRow`, `useTheme`, `TranscriptWidthToggle`, `usageLimitResumeAtom`, `usePlugins`, `usePluginList`, `useActivities`, `formatWhen`, `pluginStatusLabel`, `CREATE_PERMISSION_MODE_OPTIONS`, `CLAUDE_CODE_SETTINGS`, `OPEN_SETTINGS_EVENT`, `OPEN_COMMAND_PALETTE_EVENT`, and `export *` from `ui/command`, `ui/empty`, `ui/skeleton` and `ui/toggle-group`.
- Types: `PluginFallback`, `SettingsLocation`, `OverrideRejection`, `ModelCatalog`, `AdapterStatusJson`.

Already exported and unchanged: `openSettings`, `sendModeAtom`, `cn`, the thinking-level and permission-mode helpers, `PermissionModeItems`, `useAdapterStatus`, `useModelCatalog`, `useModelPreferences`, `Select*`, `Tooltip*`, `Button`, `Sidebar*`. `plugin-api.test.ts` must still pass.

## Plugins

Every new plugin is `category: "feature"`, `renderer: "renderer.ts"`, `load: "eager"`, no `host`.

| Plugin | `renderer.ts` setup | Files moved in |
| --- | --- | --- |
| `layout` | Also `declareList(ctx, DialogsSlot)`. | — |
| `settings` | `declareList(ctx, SettingsPagesSlot)`; dialog entry `settings` (order 10); pages `general` (10) and `plugins` (30); commands below. | `settings-dialog.tsx`, `general-settings.tsx`, `plugin-settings.tsx`, `plugin-settings.test.tsx`, and `settings-dialog.test.tsx` minus its Adapters cases |
| `command-palette` | `declareList(ctx, CommandsSlot)`; dialog entries `palette` (20) and `about` (30); commands below. | `command-palette.tsx`, `command-palette.test.tsx` |
| `adapters` | `declareList(ctx, AdapterPanelsSlot)`; page `adapters` (20); command below. | `adapter-settings.tsx`, with the Adapters cases of `settings-dialog.test.tsx` |
| `claude-code-settings` | `addEntry(ctx, AdapterPanelsSlot, { id: 'claude-code', order: 10, label: 'Claude Code', component: ClaudeCodeSettings, statusLine: ClaudeCodeHealthLabel })`; command below. | `claude-code-settings.tsx` and its test |
| `meta` | Manifest gains `"renderer": "renderer.ts"` and keeps `host` and `load: "eager"`. New `renderer.ts`: page `meta` (40); command below. | `meta-repo-settings.tsx` and its test |

Commands (each `run` calls `openSettings` or dispatches the named event):

| Plugin | `id` | `order` | `group` | `label` | `icon` | `searchOnly` | Location or effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `settings` | `settings` | 10 | Settings | Settings | `SettingsIcon` | no | `openSettings()` |
| `command-palette` | `about` | 20 | Help | About dia | `InfoIcon` | no | dispatches `OPEN_ABOUT_EVENT` |
| `command-palette` | `dev-tools` | 30 | Developer | Toggle Developer Tools | `CodeIcon` | no | `window.dia.toggleDevTools()` |
| `settings` | `general` | 110 | Settings pages | Settings › General | `SettingsIcon` | yes | `{ plugin: 'settings', id: 'general' }` |
| `adapters` | `adapters` | 120 | Settings pages | Settings › Adapters | `SettingsIcon` | yes | `{ plugin: 'adapters', id: 'adapters' }` |
| `claude-code-settings` | `claude-code` | 125 | Settings pages | Settings › Adapters › Claude Code | `SettingsIcon` | yes | `CLAUDE_CODE_SETTINGS` |
| `settings` | `plugins` | 130 | Settings pages | Settings › Plugins | `SettingsIcon` | yes | `{ plugin: 'settings', id: 'plugins' }` |
| `meta` | `meta` | 140 | Settings pages | Settings › Meta repo | `SettingsIcon` | yes | `{ plugin: 'meta', id: 'meta' }` |

Each searchOnly command keeps today's keywords from `SETTINGS_PAGE_LINKS`.

Moved tests:

- They keep their `@vitest-environment jsdom` and `@effect-diagnostics` header lines.
- Kernel-relative `vi.mock` paths become `vi.mock('@dia/renderer-plugin', importOriginal …)` overriding `useTheme`, `AboutDialog` and `openSettings`, as `plugins/chat/chat.test.tsx:17` does. They import `actions.openPluginsPage` from the barrel.
- Relative kernel imports in the moved tests (`../ui/tooltip`, `./open-settings`) become `@dia/renderer-plugin` imports; imports of a moved sibling stay relative.
- The palette test's `Settings` assertion becomes `toHaveBeenCalledWith()`, because `run` is `() => openSettings()`.
- The moved dialog test declares `SettingsPagesSlot` and adds stub General, Adapters, Plugins and Meta repo pages through `addEntry` from stub plugin contexts, so the nav-order and breadcrumb assertions stay in the `settings` test. The order of the real five plugins is checked in the app.
- The Adapters tests supply `ClaudeCodeSettings` and `ClaudeCodeHealthLabel` stubs as `AdapterPanelsSlot` entries instead of mocking `./claude-code-settings`.

### Settings dialog

- Opens on `OPEN_SETTINGS_EVENT`. With a location, it selects the page whose key is `{ plugin, id }` and passes `section` as `requestedSection`; without one, it reopens the page last viewed, or the first page by order.
- The nav lists `useList(SettingsPagesSlot)` in order.
- The dialog keeps the last reported section per page in a `Map` keyed by `plugin/id`. The breadcrumb is `Settings`, the page label, and the selected page's last reported section label. Switching pages never shows another page's label.
- A location naming no listed page selects the first page and logs a warning with the location.
- When the selected page's entry is removed, the dialog selects the first page.
- Logs `Effect.logDebug` when it opens, with the location and the page it selected.

### Command palette

- Ctrl/Cmd+K toggles the palette; `OPEN_COMMAND_PALETTE_EVENT` opens it.
- Each item's cmdk `value` is its `label` and its cmdk `keywords` are the entry's `keywords`; the React key is `plugin/id`.
- Groups are shown in the order of the lowest `order` among each group's visible items; items within a group by `order`. A group with no visible item renders no heading.
- Selecting an item closes the palette, logs `Effect.logDebug` with the entry key, then calls `run`.
- The `about` dialog entry is `AboutHost` (`plugins/command-palette/about-host.tsx`), which renders `AboutDialog` and opens when `openAbout()` from the same file dispatches its window event. The `About dia` command runs `openAbout`.

### Adapters page

- Lists every adapter plugin from `usePluginList` as today. An adapter's label and status line come from the `AdapterPanelsSlot` entry whose `id` is its name; without one, it shows the plugin name, `pluginStatusLabel(status)`, and "This adapter has no settings."
- Selection: `requestedSection` when it names a loaded adapter, else `lastSection` while that adapter is still loaded, else the first adapter. Clicking a row calls `onSectionShown({ id: name, label })`.
- It calls `onSectionShown` only once `usePluginList` has returned a list, and only when the selection differs from `lastSection`; it passes `undefined` when no adapter is loaded.
- "Open Plugins" (no adapter installed) calls `openSettings({ plugin: 'settings', id: 'plugins' })`.

## Error handling

Today a component a plugin supplies that throws while rendering unmounts the whole React tree, because no error boundary exists (`lib/slots.ts` renders with a bare `createElement`). After this change every such component renders inside a `PluginBoundary`, as `PluginSlotErrorBoundary` does in paperclip (`ui/src/plugins/slots.tsx:739`) and `SlotErrorBoundary` in deepseek-harness (`packages/client/ui-renderer/src/client/scoped-slots.tsx:443`).

Kernel, exported through `@dia/renderer-plugin`:

| Export | Contract |
| --- | --- |
| `PluginBoundary({ plugin, at, resetKey, fallback, children })` (`components/plugin-boundary.tsx`) | Renders `children`. When a descendant throws while rendering, it renders `fallback(error, retry)` (nothing when `fallback` is omitted) and logs `Effect.logError('A plugin component failed to render', { plugin, at, error, componentStack })`. It renders `children` again when the fallback calls `retry`, or when `resetKey` changes, so a plugin that reloads with a new component is shown again. `plugin` is the supplying plugin's name; `at` is the slot name. |
| `PluginFailed({ plugin, error, onRetry, size })` (`components/plugin-failed.tsx`) | The shadcn `Empty` block. `size: 'area'` (default): an error-red `TriangleAlertIcon` tile, the title "The {plugin} plugin failed to show this", the error (`name: message`) in mono on a secondary surface, clamped to two lines, then an outline `Try again` and a ghost `Open Plugins` (`openSettings({ plugin: 'settings', id: 'plugins' })`). `size: 'card'`: one caption line with a small error-red icon, the error in mono truncated to one line, and a link `Try again`. The variants use `cva`. |
| `ui/empty` | Added with `pnpm dlx shadcn@latest add empty`; exported with `export *`. |

Sites (`resetKey` is the component drawn):

| Site | Component | `fallback` |
| --- | --- | --- |
| `Slot` (`lib/slots.tsx`): `root`, `sidebar`, `main`, `main.header`, `main.tab` | the filling component | `PluginFailed`, except `main.header`: nothing |
| `Layout`: open page (`layout.tsx:132`) | `Page.component` | `PluginFailed` |
| `Layout`: `DialogsSlot` | `DialogEntry.component` | nothing |
| `agent-overview`: page nav (`agent-overview.tsx:183`) | `Page.icon` | nothing |
| `SessionRail` (`components/session-rail.tsx:115`) | `RailCard.component` | `PluginFailed size="card"` |
| Settings dialog: nav and selected page | `SettingsPage.icon`, `SettingsPage.component` | nothing, `PluginFailed` |
| Adapters page | `AdapterPanel.component`, `AdapterPanel.statusLine` | `PluginFailed`, nothing |
| Palette | `CommandEntry.icon` | nothing |

`fillSlot` provides `{ plugin: ctx.name, component }` under the slot key instead of the bare component, so `Slot` can name the plugin. Only `Slot` reads that value. A kernel default (`setKernelDefault`) renders with `plugin` set to `kernel`.

A `CommandEntry.run` that throws is caught by the palette, which logs `Effect.logError('A palette command failed', { plugin, id, error })` and calls `toast.add({ title: 'The {plugin} plugin's command failed', description: String(error), type: 'error' })`, as `plugins/agent-overview/agent-row.tsx:122` reports a failure.

Renderer logs go to the DevTools console; no code forwards them to `main.log`.

Tests that need a renderer registry start one with `startRendererRegistry(setups)` (`src/renderer/src/lib/renderer-registry.fake.ts`).

## Callers

`CLAUDE_CODE_SETTINGS` is `{ plugin: 'adapters', id: 'adapters', section: 'claude-code' }`, defined in `open-settings.ts` and imported by its three callers: `components/install-notice.tsx`, `plugins/chat/model-picker.tsx` and the `claude-code-settings` command.

## Success criteria

1. The Settings nav lists General, Adapters, Plugins, Meta repo in that order, and each page behaves as before (moved page tests; app).
2. `openSettings` opens the requested page from the palette `Settings` command (the page last viewed), the install notice and model picker (Adapters › Claude Code) and `actions.openPluginsPage` (Plugins) (tests; app).
3. `addEntry(ctx, SettingsPagesSlot, …)` adds a nav item; `registry.unload` of that plugin in the renderer registry removes it (test).
4. Ctrl+K opens the palette; typing `claude` lists `Settings › Adapters › Claude Code`; selecting it opens Settings on Adapters with Claude Code selected (app recording).
5. `addEntry(ctx, CommandsSlot, …)` adds a palette item; `registry.unload` removes it (test).
6. Packaged build: `settings`, `command-palette`, `adapters`, `claude-code-settings`, `meta` load with no error in `main.log`.
7. `pnpm typecheck` (exit code), `pnpm lint`, `pnpm test` exit 0.
8. A Settings page component that throws shows `PluginFailed` in the page area while the nav and other pages keep working; a slot filler that throws shows `PluginFailed` in its slot; a page that reloads with a component that does not throw renders again (tests).
9. A palette command whose `run` throws shows an error toast and leaves the palette usable (test).

## Documents

- New ADR `0063-settings-and-palette-plugins.md` from `docs/adr/template.md`, added to `docs/adr/README.md`. ADR-0031's status becomes "accepted, amended by ADR-0038, ADR-0040, ADR-0057, ADR-0061 and ADR-0063". It records that the kernel no longer mounts the palette or Settings, that `layout` declares `DialogsSlot`, which plugin owns each page, and that `claude-code-settings` is separate from the `claude-code` adapter because an adapter manifest has no `renderer` (ADR-0029). It also records that every component a plugin supplies renders inside a `PluginBoundary`.

## Refinement Record

| Round | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | B1 export list incomplete and partly already exported | blocker | Applied; verified `sendModeAtom` (`plugin-api.ts:173`), `cn` (`:184`), thinking-level helpers (`:174`) already exported |
| 1 | B2 About command cannot reach palette state | blocker | Applied: `about` dialog entry and `OPEN_ABOUT_EVENT` |
| 1 | B3 `api` bump must reach every manifest | blocker | Applied |
| 1 | B4 `meta` manifest needs `renderer` | blocker | Applied; registry runs nothing for a plugin with no `renderer` entry (`renderer-plugins.ts:28`) |
| 1 | M1 slot name must use plugin-name prefix | major | Applied (ADR-0061 line 30) |
| 1 | M2 palette order unspecified | major | Applied: commands table |
| 1 | M3 per-page section state | major | Applied |
| 1 | M4 `Layout` needs a fragment and keys | major | Applied |
| 1 | M5 reasoning bullet unneeded | major | Applied: removed |
| 1 | M6 ADR index and ADR-0031 status | major | Applied (ADR-0031 status line verified) |
| 1 | m1 `Dialog`/`Command` collide with shadcn exports | minor | Applied: `DialogEntry`, `CommandEntry` |
| 1 | m2 add an `adapter` field instead of using `id` | minor | Rejected: a second field would repeat `id`, which is already unique per adding plugin; the meaning of `id` is stated in the slot row. Unused `order` is now stated. |
| 1 | m3 kernel table contradicts the `section.tsx` move | minor | Applied |
| 1 | m4 moved tests | minor | Applied |
| 1 | m5 logging | minor | Applied |
| 1 | m6 the Claude Code location repeats | minor | Superseded by round 3 finding 5 |
| 1 | m7 define searchOnly | minor | Applied |
| 2 | F1 `plugin-settings.test.tsx` not moved | major | Applied |
| 2 | F2 Adapters selection drops the last-viewed fallback (`settings-dialog.test.tsx:188`) | major | Applied, by splitting `section` into `requestedSection` and `lastSection` |
| 2 | F3 kernel-relative `vi.mock` paths | major | Applied |
| 2 | F4 nav test needs entries from four plugins | major | Applied: stub entries |
| 2 | F5 `icon` type | minor | Applied (`plugins/layout/slots.ts:9`) |
| 2 | F6 why `d.key` exists | minor | Applied |
| 2 | F7 header directives | minor | Applied |
| 2 | F8 name both `pluginStatusLabel` consumers | minor | Applied |
| 3 | 1 `requestedSection` fixed at open time ignores row clicks (`settings-dialog.tsx:65-68,106-109`) | blocker | Applied |
| 3 | 2 Adapters page reports during loading | major | Applied (guard from `adapter-settings.tsx:90-92`) |
| 3 | 3 a throwing plugin component unmounts the window | major | Escalated; the user chose a boundary at every site that draws a plugin's component, with the shadcn `Empty` block as the visible fallback |
| 3 | 4 palette icons, toggle, cmdk `value`, visible-group order, test assertion | major | Applied |
| 3 | 5 `CLAUDE_CODE_SETTINGS` constant | minor | Applied; overturns the round 1 m6 reason (`open-settings.ts` is common to all three) |
| 3 | 6 relative imports in moved tests | minor | Applied |
