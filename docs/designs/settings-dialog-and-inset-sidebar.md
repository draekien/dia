# Settings dialog, inset sidebar layout and seamless title bar (issue #52)

Scope: layer. Spans the renderer kernel (`src/renderer/src`), the `layout` and `agent-overview` renderer plugins, the main process window setup (`src/main`), the shared IPC contract, and docs. One PR, branch `feat/settings-dialog-inset-sidebar`.

## Name and Purpose

dia's window becomes one shadcn inset-sidebar layout with no separate title bar, and every setting moves into one Settings dialog reached from one command palette item.

## Success criteria

Confirmed with the user in Understand. Each maps to a test (T) or to Verify (V).

1. With an empty query, the palette lists only Settings, About dia and Toggle Developer Tools, with no toggle rows. (T)
2. `plug` → `Settings › Plugins`, `theme` → `Settings › General`, `models` → `Settings › Adapters › Claude Code`. Selecting a result opens the dialog on that page. (T)
3. The dialog nav lists General, Adapters and Plugins. Selecting one shows that page and updates the breadcrumb. (T)
4. General changes theme, send mode and transcript width. (T)
5. Adapters lists one row per adapter plugin with a status line. Selecting a row shows its settings (Health, Defaults, Models for Claude Code). With no adapters, it shows "No adapter plugin is installed". (T)
6. "Manage models…" and "Open Settings" open Adapters › Claude Code. `openPluginsPage()` opens Plugins. (T)
7. `Escape` closes the dialog, and the tab that was visible before is still visible. (V)
8. No title bar band: the sidebar and the content card start at the top of the window, and the window controls draw over the app. Dragging the sidebar's top row or the card header moves the window; buttons in those rows still respond to clicks. (V)
9. `Ctrl B` and ☰ switch between the expanded sidebar and the dot rail, and the state survives a restart. (T + V)
10. Collapsed: Meta first, then one dot per agent with the tooltip `project / agent · status · activity`, and a separator between projects. (T)
11. Dragging the rail resizes the sidebar between 14rem and 32rem, and the width survives a restart. Double-click resets to 18rem. `←`/`→`/`Home` work on the focused rail. (T for keyboard and limits, V for drag)
12. A window narrower than 768px still shows the sidebar. (V)
13. Rows: the list has one tab stop; arrow keys, `F2` rename, the context menu and drag reordering behave as they do today. (T + V)
14. The selected row uses the primary tint and looks different from a hovered row. (V)
15. `pnpm test` and `pnpm typecheck` exit 0.

## Internal Decomposition

Organised by what each module owns.

- **Sidebar primitives** (`src/renderer/src/components/ui/sidebar.tsx`, `sheet.tsx`, `breadcrumb.tsx`, `src/renderer/src/hooks/use-mobile.ts`; added with `shadcn add sidebar breadcrumb`) — the shadcn sidebar, with six local edits (table below); the Sheet branch stays in the file but never renders. Owns the sidebar's open state context, width, and the `Ctrl B` shortcut.
- **Layout plugin** (`plugins/layout/layout.tsx`) — the window frame: `SidebarProvider`, the `sidebar` slot, and the inset card holding the header row (☰, separator, `main.header` slot) above the `main` slot. Owns persisting the sidebar's open state and width.
- **Agent overview plugin** (`plugins/agent-overview/*`) — fills the `sidebar` slot with `Sidebar variant="inset" collapsible="icon"`. Owns the wordmark row, search, filters, project groups and agent rows, and how they render collapsed.
- **Tab header** (`src/renderer/src/components/tab-header.tsx`, moved out of `tab-content.tsx`) — the kernel default for `main.header`: the breadcrumb for the current view, the transcript width control, and the window status items formerly in `AppHeader`.
- **Settings dialog** (`src/renderer/src/components/settings/*`) — the dialog, its nav, its pages, and the `openSettings` request channel. Owns which page and adapter were last viewed.
- **Command palette** (`command-palette.tsx`) — commands plus search-only links into Settings pages.
- **Title bar overlay** (`src/main/index.ts`, `src/main/ipc/window-ipc.ts`, `theme-provider.tsx`, `TitleBarOverlayColors` in `src/shared/ipc/contract.ts`) — a transparent overlay whose symbol colour follows the theme.

## Interface

### Sidebar primitives (`@renderer/components/ui/sidebar`)

Installed by `pnpm dlx shadcn@latest add sidebar breadcrumb`. Per `docs/reasoning/2026-10-24-shadcn-add-installs-cn-npm-package.md`, check `git diff package.json pnpm-lock.yaml` and every new file's imports after the command.

Local edits, each kept minimal so a later `shadcn add --diff` stays readable:

| Edit | Where | Why |
|---|---|---|
| `useIsMobile` returns `false`, with the JSDoc `/** Reports whether the viewport is mobile-sized; dia always returns false because it is a desktop window. */` | `hooks/use-mobile.ts` | dia is a desktop window; the Sheet branch is never wanted |
| Remove the inner `<TooltipProvider delayDuration={0}>` from `SidebarProvider`; `main.tsx` already supplies one with `delayDuration={400}` | `sidebar.tsx` | The layout provider wraps the card and the pane, so the inner provider would set a 0ms delay on every tooltip in the window |
| Remove the `sidebar_state` cookie write from `setOpen` | `sidebar.tsx` | Nothing reads it; the layout plugin persists `open` |
| Remove `md:` from `Sidebar` (wrapper `md:block`, container `md:flex`), from `SidebarInset`'s five `md:peer-data-…` classes, and from the `SidebarGroupAction`/`SidebarMenuAction` `md:` classes (`after:hidden`, `opacity-0`); the replacement `SidebarRail` has no `sm:flex` | `sidebar.tsx` | Below 768px the desktop sidebar is `hidden` and the inset card loses its margin and radius (criterion 12) |
| `data-[active=true]:bg-sidebar-primary/10` (hover keeps `bg-sidebar-accent`) | `sidebarMenuButtonVariants` | DESIGN.md: the selected item uses the primary tint and differs from hover (criterion 14) |
| Resizable `SidebarRail` and width props on `SidebarProvider` | `sidebar.tsx` | Criterion 11; shadcn's rail only toggles |

`SidebarProvider` gains controlled width props next to the existing `open`/`onOpenChange`:

```ts
/** Makes the sidebar resizable from its rail; pass it to `SidebarProvider` as `resize`. All widths are px. */
export interface SidebarWidth {
  /** The saved width; `undefined` means `defaultWidth`. Clamped to `minWidth`–`maxWidth` before use. */
  readonly width: number | undefined
  /** The width used when nothing is saved, and the width a reset returns to. */
  readonly defaultWidth: number
  /** Called once when a drag or key press ends (`px`), or on reset (`undefined`). */
  readonly onWidthChange: (width: number | undefined) => void
  /** The narrowest width a drag or key press can set. */
  readonly minWidth: number
  /** The widest width a drag or key press can set. */
  readonly maxWidth: number
}
function SidebarProvider(props: React.ComponentProps<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  resize?: SidebarWidth
}): JSX.Element
```

`SidebarRail` (no new props) behaves as below when the provider has `resize`; without `resize` it keeps shadcn's click-to-toggle.

| Input | Expanded | Collapsed |
|---|---|---|
| Pointer drag past 3px | Sets the width live (clamped), calls `onWidthChange(px)` once on release | Not rendered as interactive (`hidden` in icon mode) |
| Click | Nothing | — |
| Double click | `onWidthChange(undefined)` | — |
| `←` / `→` (focused) | Width −/+ 16px, clamped, `onWidthChange(px)` | — |
| `Home` (focused) | `onWidthChange(undefined)` | — |

With `resize`, the provider sets `--sidebar-width` to the clamped `width ?? defaultWidth` in px, after spreading `style`; the rail's arrow keys and `aria-valuenow` start from that same number. On release the rail sets the wrapper's `--sidebar-width` imperatively (as t3code's `finish()` does), calls `onWidthChange`, and only then clears its inline `width` writes, so the sidebar does not snap back for a frame (unverified; check in Verify).

The rail renders as `<div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuenow aria-valuemin aria-valuemax tabIndex={0}>` while expanded. During a drag it writes `width` to the `sidebar-gap` and `sidebar-container` elements with `transition-duration: 0ms`; the provider's `--sidebar-width` changes only on release (t3code `apps/web/src/components/ui/sidebar.tsx:379-470`, `hooks/useResizeDrag.ts`).

### Plugin API (`src/renderer/src/plugin-api.ts`, consumed as `@dia/renderer-plugin`)

Adds `export * from './components/ui/sidebar'` (all `Sidebar*` parts and `useSidebar`). `PLUGIN_API_VERSION` 0.0.2 → 0.0.3 in `src/shared/plugin/manifest.ts`, and `"api": "0.0.3"` in every `plugins/*/plugin.json` (ADR-0032). Test fixtures with a literal `api: '0.0.2'` (`src/host/plugins/host-plugins.test.ts`, `plugin-loader.test.ts`, `plugin-sources.test.ts`, `src/renderer/src/plugins/renderer-plugins.test.ts`, and `src/shared/plugin/manifest.test.ts` where it means the host version) use `PLUGIN_API_VERSION`, because the registry refuses a patch mismatch below 0.1.0 (`plugin-registry.ts:438`).

### Layout plugin (`plugins/layout/layout.tsx`)

```tsx
<SidebarProvider className="h-full min-h-0" open={open} onOpenChange={saveOpen}
                 resize={{ width, defaultWidth: 288, onWidthChange: saveWidth, minWidth: 224, maxWidth: 512 }}>
  <Slot name={SIDEBAR} empty={<NoSidebarPlugin />} />
  <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
    <header className="titlebar-drag flex h-8 shrink-0 items-center gap-2 px-2 pr-(--titlebar-controls-inset)">
      <SidebarTrigger />
      <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
      <Slot name={MAIN_HEADER} />
    </header>
    <Separator />
    <div className="min-h-0 flex-1"><Slot name={MAIN} /></div>
  </SidebarInset>
</SidebarProvider>
```

`h-full min-h-0` on the provider and `min-h-0 overflow-hidden` on the inset override shadcn's `min-h-svh` wrapper, so a long transcript scrolls inside the card instead of growing the page. The Settings dialog's `style` with a `--sidebar-width` key is cast `as CSSProperties`, as shadcn does, because `React.CSSProperties` has no custom-property keys.

| Key | Value |
|---|---|
| `localStorage['dia.sidebar.open']` | `'1'` or `'0'`. When absent, read once from `dia.agent-overview.rail` (`'1'` means collapsed), a one-time migration of the key `agent-overview.tsx` used to own; `agent-overview.tsx` drops its `RAIL_KEY` constant. |
| `localStorage['dia.sidebar.width']` | px number; removed on reset. A value that does not parse is ignored; the range is enforced by `SidebarProvider`. |

The layout logs with `Effect.runSync(Effect.logDebug(...))`, as `lib/actions.ts` does, when it migrates the legacy key and when it saves or resets the width.

### Agent overview plugin

```tsx
<Sidebar variant="inset" collapsible="icon">
  <SidebarHeader className="pt-0">
    <div className="titlebar-drag flex h-8 items-center px-2">dia</div>      {/* hidden in icon mode */}
    <search row: SidebarInput (Ctrl P) · FilterPopover · Add project />     {/* hidden in icon mode */}
  </SidebarHeader>
  <SidebarContent>
    <Meta item />
    <one SidebarGroup per project />
  </SidebarContent>
  <SidebarRail />
</Sidebar>
```

| Part | Expanded | Collapsed (`useSidebar().state === 'collapsed'`) |
|---|---|---|
| Wordmark row | `dia`, a drag row of `h-8`. `SidebarHeader` has `pt-0`, so the row is centred at 8px (container padding) + 16px = 24px, level with the card header row and the window controls | An empty drag row of the same height |
| Search row | As today | Not rendered; filters are ignored (as the rail did with `NO_FILTERS`) |
| Meta | `SidebarMenuItem` with the marker, "Meta", "No open proposals" | The marker only, `tooltip="Meta · No open proposals"`; the text span is hidden as for agent rows |
| Project (collapsed: a `SidebarSeparator` precedes each project with agents, including the first, and projects with no agents are skipped, as `rail.tsx` did) | `SidebarGroup`; header is `SidebarGroupLabel asChild` over a `<button>` (sortable activator, chevron, name, `git` chip, urgent dot when closed, count) with `pr-8` reserving the action's slot, so the urgent dot and count sit left of it. New agent is a `SidebarGroupAction` (shadcn: `absolute top-3.5 right-3 w-5`) with `tabIndex={-1}`, `aria-label="New agent in <project>"`, and `opacity-0` revealed on the group's hover and focus-within, as today | The label gets `group-data-[collapsible=icon]:hidden` (shadcn only fades it with `-mt-8 opacity-0`, which would leave an invisible drag activator over the previous dot); `useSortable({ disabled: true })`; every group renders open; a `SidebarSeparator` between groups |
| Agent row | `SidebarMenuItem` → `SidebarMenuButton size="lg" isActive tooltip`: status dot, name, second line | The status dot only: the button's text span gets `group-data-[collapsible=icon]:hidden` and the button `group-data-[collapsible=icon]:justify-center` (shadcn's `lg` size sets `p-0!` in icon mode, and the `flex-1` text span would otherwise push the dot to the left edge); tooltip `project / agent · status · second line` |
| Archived | Shown only when the "Show archived agents" filter is on (unchanged): a caption `Archived · n` then the archived rows | Not shown |
| Footer | Removed. ☰ in the card header and `Ctrl B` replace "Collapse" | — |

`useWindowShortcuts` keeps `Ctrl P` and drops `Ctrl B`, which `SidebarProvider` handles. `Ctrl P` calls `setOpen(true)` and then `requestAnimationFrame(() => searchRef.current?.focus())`, which is what `focusSearch` does today with `setRail(false)`. `rail.tsx` is deleted; `MetaMarker` moves into `agent-overview.tsx`. The `ScrollArea` and its `block!` workaround are removed: `SidebarContent` scrolls itself, and gets `group-data-[collapsible=icon]:overflow-y-auto group-data-[collapsible=icon]:overflow-x-hidden` because shadcn sets `overflow-hidden` in icon mode and the dots must scroll as `rail.tsx`'s did.

While `workspace` is `undefined`, the plugin renders `<Sidebar variant="inset" collapsible="icon" />` with an empty body, so `SidebarInset`'s `peer` styles (margin, radius) apply from the first frame.

While collapsed, the targets are only the `RowTarget`s of `navigationOrder`, and the tab stop falls back to the first row, because a hidden header cannot take focus. Otherwise the one-tab-stop list (`data-nav`, `onListKeyDown`, `tabStop`) is unchanged; `SidebarMenuButton` receives `data-nav`, `tabIndex` and `onKeyDown` as props.

### Tab header (`main.header` kernel default)

| View | Breadcrumb | Right side |
|---|---|---|
| `TabView` | `project › agent` (`BreadcrumbPage` on the agent), worktree branch chip | Transcript width button · window status |
| `NewAgentView` | `project › New agent` | window status |
| `FirstRunView`, `EmptyProjectView`, startup | none | window status |

"Window status" is `PluginLoadIndicator`, `UpdateIndicator` and `CommandPaletteHint`, moved from `app-header.tsx` (which is deleted) into `window-status.tsx`. `WindowStatus` is rendered by the kernel inside `TabHeader`; a plugin that fills `main.header` owns the status items, and ADR-0038 records this. Interactive children are `no-drag` by the rule in `index.css`. Tooltips and popovers opened from this row use `side="bottom"`.

`tab-content.tsx` no longer renders `<Slot name={MAIN_HEADER} />`; the layout plugin does, for every view. `main.tsx` imports `TabHeader` from `tab-header.tsx`. The JSDoc of `ROOT` ("below the title bar") and `MAIN_HEADER` in `lib/slots.ts` is updated.

### Settings dialog (`src/renderer/src/components/settings/`)

```ts
/** A page of the Settings dialog; `adapter` names an adapter plugin (`PluginInfo.name`). */
export type SettingsLocation =
  | { readonly page: 'general' }
  | { readonly page: 'adapters'; readonly adapter?: string }
  | { readonly page: 'plugins' }

/** Opens the Settings dialog on `location`, or on the page last viewed when omitted. */
export function openSettings(location?: SettingsLocation): void

/** Mounted once in `main.tsx` next to `CommandPalette`, inside its `TooltipProvider`; listens for `openSettings`. */
export function SettingsDialog(): JSX.Element
```

`openSettings` logs the requested location with `Effect.logDebug`, as `lib/actions.ts` does. `openPluginsPage()` stays exported from `plugin-api.ts` and `lib/actions.ts` and calls `openSettings({ page: 'plugins' })`; `openSettings` is not added to the plugin API. `openSettingsPage` and `onSettingsPageRequested`/`onPluginsPageRequested` are removed; `model-picker.tsx` and `install-notice.tsx` call `openSettings({ page: 'adapters', adapter: 'claude-code' })`.

| File | Contents |
|---|---|
| `settings-dialog.tsx` | `DialogContent className="overflow-hidden p-0 sm:max-w-4xl h-[min(40rem,85vh)]"` (`sm:` overrides the built-in `sm:max-w-lg`; `DialogTitle` "Settings" visually hidden) → `SidebarProvider className="h-full min-h-0 items-start" style={{ '--sidebar-width': '12rem' } as CSSProperties}` → `Sidebar collapsible="none" className="h-full"` nav (General · Adapters · Plugins, `SidebarMenuButton isActive`) + `<section aria-label="Settings page" className="flex min-w-0 flex-1 flex-col">` (not `main`: `SidebarInset` is already the window's `main` landmark) with a `Breadcrumb` header that has `pr-12` to clear the dialog's close button, and a `min-h-0 flex-1 overflow-auto` body |
| `general-settings.tsx` | Theme and send mode `ToggleGroup`s (moved from the palette), `TranscriptWidthToggle` |
| `adapter-settings.tsx` | Adapter list (a bordered `SidebarMenu` above the page, one row per `usePluginList()` entry with `category === 'adapter'`) and the selected adapter's page below it. Above, not beside: a side column would leave the page about 21rem and squeeze the three-column Defaults grid. |
| `claude-code-settings.tsx` | Today's `SettingsPage` body: Health, Defaults, Models, and the stale health re-check on mount; also `ClaudeCodeHealthLabel`. The "Claude Code" heading is dropped, because the breadcrumb and the adapter row name it. `settings-page.tsx` is deleted. |
| `plugin-settings.tsx` | Today's `PluginsPage` list body. `plugins-page.tsx` is deleted. |

Adapter pages are looked up in one table:

```ts
interface AdapterPage {
  readonly label: string
  readonly Page: ComponentType
  readonly StatusLine: ComponentType
}
const ADAPTER_PAGES: ReadonlyMap<string, AdapterPage> = new Map([
  ['claude-code', { label: 'Claude Code', Page: ClaudeCodeSettings, StatusLine: ClaudeCodeHealthLabel }]
])
```

`ADAPTER_PAGES.get(name)` returns `AdapterPage | undefined`, so the type forces the missing-entry branch.

The adapter list renders `<StatusLine />` in each row, so each row's hooks run inside its own component. An adapter plugin with no entry shows its `name`, its plugin status label as the status line, and "This adapter has no settings." The selected adapter is `location.adapter` when it is in the list, else the last one viewed when it is still loaded, else the first in the list. While `usePluginList().plugins` is `undefined`, the page shows a `Skeleton` and selects nothing. For a loaded list with no `category === 'adapter'` entry it shows "No adapter plugin is installed" and a button that opens Plugins.

### Command palette

```
query ''      → Settings · About dia · Toggle Developer Tools
query 'plug'  → Settings › Plugins
```

`CommandInput` becomes controlled (`value`, `onValueChange`; `cmdk` `Command.Input`, `node_modules/cmdk/dist/index.d.ts:136`). While the query is non-empty, a "Settings pages" group renders one `CommandItem` per location with `keywords` (`cmdk` `Item.keywords`, `index.d.ts:84`):

| Item | `keywords` |
|---|---|
| Settings › General | theme, dark, light, send mode, queue, steer, transcript width |
| Settings › Adapters | adapter |
| Settings › Adapters › Claude Code | claude, models, model, health, install |
| Settings › Plugins | plugin, extensions |

The query resets to `''` whenever the palette closes. The Theme, Send mode and Transcript width rows and the "Manage plugins" group are removed, and `CommandPalette`'s JSDoc no longer mentions them.

### App shell (`app.tsx`)

Renders `<div className="h-screen bg-sidebar"><Slot name={ROOT} empty={<NoLayoutPlugin />} /></div>`. The `page` state, `shownBeforePage`, `selectTab(null)` on page open, and `<AppHeader />` are removed. `NoLayoutPlugin` renders a `titlebar-drag h-8 pr-(--titlebar-controls-inset)` row holding `<WindowStatus />` above its message, so the window can still be moved and plugin-load progress stays visible, and its message reads: "No layout plugin is loaded. Press Ctrl K, type "plug", and load the layout plugin from Settings › Plugins."

### Title bar overlay

```ts
// src/shared/ipc/contract.ts
export const TitleBarOverlayColors = Schema.Struct({ symbolColor: Schema.String })
```

Its JSDoc is rewritten: the renderer sends only `symbolColor`; main fixes the overlay background as transparent.

| Where | Change |
|---|---|
| `src/main/index.ts` | `TITLE_BAR_HEIGHT = 48`; `initialOverlay.color = '#01000000'` in both themes. Electron v45 `docs/tutorial/custom-title-bar.md:157-158`: overlay colours accept `#RRGGBBAA` "and support transparency", so the alpha byte is `00`; t3code `DesktopWindow.ts:56` uses this value because `#00000000` does not work correctly on Linux |
| `window-ipc.ts` `wireTitleBarOverlay` | `setTitleBarOverlay({ color: '#01000000', symbolColor })` |
| `theme-provider.tsx` | Pushes only `symbolColor` |
| `index.css` | `button, input, a, [role=separator]` inside `.titlebar-drag` get `-webkit-app-region: no-drag` (the existing `.titlebar-no-drag` class stays); `--titlebar-controls-inset: calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px) + 0.75rem)` |

Overlay height 48 = the inset margin (8px) + the `h-8` header row (32px) + 8px, so the controls (centred at 24px) line up with the header row's centre (8 + 16 = 24px) and the sidebar's wordmark row (8px container padding + `h-8`, with `SidebarHeader pt-0`).

macOS is not handled: its traffic lights would sit over the wordmark row. ADR-0038 states the layout targets Windows and Linux, as ADR-0017 does.

Verify also checks that the drag rows under an open dialog's overlay do not move the window (Electron drag regions ignore `z-index`; unverified).

## Key Data Structures

- `SettingsLocation` (above). `page` is a closed union, so an unknown page cannot be requested.
- `SidebarWidth` (above). `minWidth ≤ width ≤ maxWidth` holds for every value the provider applies; out-of-range input is clamped by the provider alone.
- `TitleBarOverlayColors` loses `color`: the renderer can no longer send an opaque overlay colour.

## Design Rationale

**The layout plugin renders `main.header`.** The header row must exist in every view (it is the drag row and holds ☰), and only the layout owns the card. Moving the slot out of `TabContent` changes ADR-0031's slot table; the new ADR records it.

**Width is controlled like `open`.** `SidebarProvider` already takes `open`/`onOpenChange`; width follows the same pattern, so the sidebar primitive never touches `localStorage` and the layout plugin owns both persisted values (Information Hiding: the rail hides the gap/container writes).

**One `openSettings(location)`.** Every entry point names a page; `openPluginsPage` survives only as the public plugin API name.

**Adapter pages in a kernel table.** Only one adapter exists and it has no renderer entry; `AdapterStatusFeed` reports one backend's status. A table keyed by plugin name gives the Adapters page its shape without inventing an adapter-UI plugin contract.

**Transparent overlay with symbol-only sync.** Drops the 40px band and the background colour sync; the theme probe stays for `symbolColor`.

**Archived without a `Collapsible`.** Archived rows already appear only when the "Show archived agents" filter is on (`overview.ts`, `buildOverview`); a second open/close control would add a state `navigationOrder` would have to track.

## Rejected Alternatives

**Adapter plugins contribute their own settings page through a renderer slot.** Rejected for now: `claude-code` has no renderer entry, and a slot contract for one adapter would be shaped by its only caller.

**`SidebarRail` persists its own width (`storageKey`, as t3code does).** Rejected: the open state is already controlled by the layout plugin; two persistence owners for one sidebar would split the knowledge.

**Keep a 40px title band and offset the sidebar with `top-10`.** Rejected by the user in shape.

**`Collapsible` + `SidebarMenuSub` for archived rows (issue #52 §1).** Rejected: see Design Rationale; the filter already gates archived rows.

## Docs

- New ADR-0038 "Draw the window controls over a transparent overlay and use the shadcn inset sidebar as the window frame": supersedes ADR-0017's header and colour-sync decisions; amends ADR-0031's slot table (`main.header` is rendered by the layout plugin) and its "Kernel" row ("Renders only `<AppHeader/>` and the `root` slot"). Index updated; ADR-0017 and ADR-0031 status lines updated.
- DESIGN.md: replace the Flat-Surface Rule with the inset card; add a resting card level to §4 Elevation; update Agent Overview (resize, collapse, `SidebarMenu` rows, footer removed) and Tabs (breadcrumb header).
- `docs/designs/agent-overview.md`: line 21 (`Ctrl B` status rail), line 39 (settled decision "Rail") and line 271 (`dia.agent-overview.rail`, `rail.tsx`) describe the collapsed sidebar (icon mode) and `dia.sidebar.open`.
- `docs/designs/adapter-settings.md:250`: the `openSettingsPage()` reference becomes `openSettings({ page: 'adapters', adapter: 'claude-code' })` in the Settings dialog.

## Tests

| Criterion | Test file |
|---|---|
| 1, 2 | `command-palette.test.tsx` (new) |
| 3, 4, 5, 6 | `settings/settings-dialog.test.tsx` (new); `claude-code-settings.test.tsx` and `plugin-settings.test.tsx` (renamed from the page tests) |
| 9, 11 (keyboard, clamp, reset) | `ui/sidebar.test.tsx` (new, rail only); `plugins/layout/layout.test.tsx` (new, persistence and legacy key) |
| 9 (`Ctrl B` with the dialog open toggles the main sidebar; the dialog's own provider also toggles, which has no effect because its nav is `collapsible="none"`) | `plugins/layout/layout.test.tsx` |
| 11 (a stored `9999` is applied as 512; `→` from no saved width gives 304) | `plugins/layout/layout.test.tsx`, `ui/sidebar.test.tsx` |
| 5 (an adapter plugin with no `ADAPTER_PAGES` entry shows "This adapter has no settings.") | `settings/settings-dialog.test.tsx` |
| 10, 13 | `plugins/agent-overview/agent-overview.test.tsx` (new): exactly one `tabIndex=0` element in the expanded list (the New agent actions included), arrows, `F2`, collapsed tooltips and separators, and while collapsed exactly one `tabIndex=0` element, which is a row |
| Breadcrumb per view | `tab-header.test.tsx` (new) |
| `TitleBarOverlayColors` decodes `{ symbolColor }` and rejects a payload without it | `src/shared/ipc/contract.test.ts` (new) |

## Implementation notes

- `shadcn add sidebar breadcrumb` again wrote `import { cn } from "cn"`, added the `cn` npm package, and also appended generic `--sidebar*` variables to `index.css`; all three were reverted (`docs/reasoning/2026-10-24-shadcn-add-installs-cn-npm-package.md`).
- The new shadcn files carry JSDoc only on the parts dia added (`SidebarWidth`, `SidebarRail`, `useIsMobile`), matching the other files in `components/ui/`.
- The project header is a real `<button>`, so `Enter` toggles it natively; `Space` still lifts it through the dnd-kit keyboard sensor.

## Refinement Record

**Applied**
- Round 1, blocker, Correctness — shadcn's provider wrapper is `min-h-svh`, so the transcript would grow the page. The layout now sets `h-full min-h-0` on the provider, `min-h-0 overflow-hidden` on the inset, and wraps `main` in `min-h-0 flex-1`.
- Round 1, blocker, Correctness — the dialog's provider wrapper is taller than the dialog. The dialog provider now has `h-full min-h-0`, with a 12rem nav width and a scrolling body.
- Round 1, major — in icon mode the group label is only faded, so its drag activator would sit over a dot, and header tab stops cannot take focus. The label is now hidden and sorting disabled, and the targets are rows only while collapsed.
- Round 1, major — `Ctrl P` focused a search row that is not rendered while collapsed. Focus is now deferred until the sidebar expands.
- Round 1, major — the `lg` button has `p-0!` in icon mode, so the dot sat off-centre. Added `justify-center`.
- Round 1, major — a plugin filling `main.header`, or a missing layout plugin, lost the status items or the drag region. Recorded in ADR-0038, and `NoLayoutPlugin` now has a drag row and an updated message.
- Round 1, major — the wordmark row's centre was wrong because `SidebarHeader` adds `p-2`. It now uses `pt-0`.
- Round 1, major — `md:`/`sm:` gates also exist on actions and the rail. The full list is in the edit table.
- Round 1, major — the saved width must override `style`, and the drag release must not snap back for a frame. Ordering specified.
- Round 1, major (Rules of Hooks) — `useStatusLine` in a table became a `StatusLine` component.
- Round 1, minor — palette query reset; a stale adapter falls back to the first; additional design docs and ADR-0031 rows; `main.tsx` import; `slots.ts` JSDoc; JSDoc instead of a `shortcut:` comment (project rule: no comments); contract JSDoc; extra tests; macOS stated as out of scope.

- Round 2, blocker — `max-w-4xl` lost to the built-in `sm:max-w-lg`. Now `sm:max-w-4xl`, and the breadcrumb clears the close button.
- Round 2, blocker — `justify-center` could not centre the dot past a `flex-1` span. The text span is now hidden in icon mode.
- Round 2, major — icon mode sets `overflow-hidden` on `SidebarContent`, so the dots could not scroll. Overridden.
- Round 2, major — `SidebarProvider`'s inner `TooltipProvider delayDuration={0}` would apply to the whole window. Removed, along with the unread `sidebar_state` cookie.
- Round 2, major — `SidebarGroupAction` overlapped the count and added a tab stop. Reserved `pr-8`, `tabIndex={-1}`, hover/focus reveal, and a test.
- Round 2, major — the API bump breaks fixtures that hardcode `'0.0.2'`. Fixtures now use `PLUGIN_API_VERSION`.
- Round 2, minor — Adapters loading state and the "No adapter plugin is installed" wording; the overview's loading sidebar; `SettingsDialog` mounts in `main.tsx`; `as CSSProperties`; `Ctrl P` uses `requestAnimationFrame` instead of a flag; five inset classes; doc line references; `contract.test.ts` marked new; `ClaudeCodeHealthLabel` placed; `section` instead of a nested `main`; `WindowStatus` in `NoLayoutPlugin`; `#RRGGBBAA` cited from the Electron docs; Verify checks drag rows under the dialog overlay.

- Round 3, major — the rail's arrow keys had no number to start from when no width is saved (the default lived in a rem CSS variable). `SidebarWidth` now carries `defaultWidth` in px, and the layout passes 288 instead of a `style` default.
- Round 3, minor — criterion 5 uses the "No adapter plugin is installed" wording; only the provider clamps; the decomposition says six edits and the Sheet branch stays dormant; `SidebarWidth` and `SettingsLocation` are exported with JSDoc; `ADAPTER_PAGES` is a `ReadonlyMap`; the legacy key migration is spelled out; logging uses the `lib/actions.ts` pattern; the dialog's inert `Ctrl B` is stated; the palette JSDoc is updated and the search group is renamed "Settings pages"; tests added.

**Rejected**
- Round 1, major — "`.titlebar-drag > *` resets break dragging over `TabHeader`; use `display: contents`". Rejected the reset rule itself instead. t3code added it because Electron 44 creates drag rectangles over fixed-position controls (`.repos/t3code/apps/web/src/index.css:1748-1756`). dia's drag rows contain no fixed-position controls, and dia's current header already drags with inherited `app-region` and explicit `no-drag` children (`app-header.tsx:70-76`).
