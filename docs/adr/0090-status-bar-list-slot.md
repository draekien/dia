---
status: "accepted"
date: 2026-11-25
decision-makers: William Pei
---

# A full-width status bar: a list slot owned by `dia-layout`

## Context and Problem Statement

dia has no place that shows dia's own state (for example its version, or plugins that failed to load) all the time, and plugins have no place to show a short status line of their own. Objective "Add a task bar at the bottom of the dia app" (issue `73a66c02-a4e6-47ac-b9d6-0e878ae58215`) asks for a bar along the bottom of the window that shows dia's information and takes entries from plugins. ADR-0061 lets a plugin declare a list that other plugins add entries to; `plugins/dia-layout/slots.ts` already declares `PagesSlot`, `SidebarSectionsSlot` and `DialogsSlot` this way. Which list, entry type, position, owner and name does the bar use?

## Decision Drivers

* ADR-0019: every feature dia ships with, including dia's own entries in the bar, can be removed by a plugin.
* ADR-0061: a plugin declares a list it draws, and contributors call `addEntry`.
* A failing entry must not take down the bar or the window.
* The bar must not be confused with the chat pane's resizable bottom panel (`src/renderer/src/components/bottom-panel.tsx`).
* The bar spans the full window width (user choice, 2026-11-25).

## Considered Options

* Position: across the full window width, below `SidebarProvider` / inside `SidebarInset`, under the content area
* Entry type: `component` draws the whole entry / entries are data (`label`, `icon`, `tooltip`, `onClick`)
* dia's own entries: a `dia-status-bar` plugin / `dia-layout` itself
* Name: "status bar" / "task bar"

## Decision Outcome

Chosen options: across the full window width; `component` draws the whole entry; a `dia-status-bar` plugin; "status bar". The user chose the name and the position on 2026-11-25.

* `plugins/dia-layout/slots.ts` exports:

  ```ts
  /** An entry in the status bar. `side` picks the left (`start`) or right (`end`) group; `order` sorts within the group, the lowest `order` nearest the group's outer edge. `component` draws the whole entry, including any tooltip or click action. */
  export interface StatusBarItem {
    readonly id: string
    readonly order: number
    readonly side: 'start' | 'end'
    readonly component: ComponentType
  }

  /** The status bar's entries, declared by the layout plugin. Add one with `addEntry(ctx, StatusBarItemsSlot, item)`. */
  export const StatusBarItemsSlot = ListSlot.make<StatusBarItem>('layout.statusBar')
  ```

* `Layout` in `plugins/dia-layout/layout.tsx` wraps `SidebarProvider` in a flex column of height `h-full`. `SidebarProvider` gets `min-h-0 flex-1`, and the status bar is the column's last child. The bar is one row of fixed height across the full window width, under the sidebar and the content column. It holds the `start` entries on the left and the `end` entries on the right.
* `src/renderer/src/components/ui/sidebar.tsx` changes the `sidebar-container` element from `fixed inset-y-0 h-svh` to `absolute inset-y-0 h-full`, and the `group/sidebar-wrapper` element gets `relative`. The sidebar then ends at the top edge of the status bar instead of covering the bar's left end. This changes a vendored shadcn component; make the change with the `shadcn` skill (`src/renderer/CLAUDE.md`).
* The status bar is not the bottom panel. The bottom panel (`src/renderer/src/components/bottom-panel.tsx`) belongs to one chat pane, is resized by dragging, is toggled with Ctrl/⌘ J, and holds panels such as terminals. The status bar belongs to the window, cannot be resized, holds only `StatusBarItemsSlot` entries, and is drawn below both the sidebar and the content column.
* `Layout` does not draw the status bar while the list is empty.
* Each entry renders inside its own `PluginBoundary` with `key` `` `${item.key.plugin}/${item.key.id}` ``, `plugin={item.key.plugin}`, `at={StatusBarItemsSlot.name}` and `resetKey={item.component}`. Its `fallback` draws a marker the height of one entry that names the plugin and calls `retry` when clicked. The other entries keep rendering. `PluginBoundary`'s default fallback renders nothing, which would hide the failure.
* The user can hide the status bar. `dia-layout` adds a "Toggle status bar" command to `CommandsSlot` (`plugins/dia-command-palette/slots.ts`) with `addEntry`, and saves the choice in `localStorage` under `dia.statusBar.open`, the same way it saves `dia.sidebar.open`. While `dia-command-palette` is not loaded, the bar stays visible.
* A new plugin `dia-status-bar` (ADR-0077 naming) adds dia's own entries with `addEntry`. A plugin that owns some state adds the entry for that state itself, so `dia-status-bar` adds entries only for state no other plugin owns.
* `docs/glossary.md` defines "Status bar".

This ADR does not amend ADR-0031 or ADR-0061. It declares a list under ADR-0061's rules, as ADR-0083 declared `ThreadTargetsSlot`.

### Consequences

* Good, because a plugin adds a status entry in one `addEntry` call, with no kernel change and no `PLUGIN_API_VERSION` bump.
* Good, because unloading `dia-status-bar` removes dia's own entries and keeps other plugins' entries.
* Good, because a failed entry shows a marker the user can click to retry, and the rest of the bar keeps rendering.
* Bad, because `src/renderer/src/components/ui/sidebar.tsx` differs from upstream shadcn. A later `shadcn add sidebar --overwrite` restores `fixed inset-y-0 h-svh`, and the sidebar again covers the left end of the bar.
* Bad, because each entry draws its own tooltip and button, so entries from different plugins can look different. A shared entry component exported from `@dia/renderer-plugin` can be added once two plugins duplicate one.

## Pros and Cons of the Options

### Position: across the full window width, below `SidebarProvider`

* Good, because the bar spans the whole window, as VS Code's status bar does.
* Bad, because the sidebar container is `fixed inset-y-0 h-svh z-10` (`src/renderer/src/components/ui/sidebar.tsx:209`), so the vendored shadcn component must change to `absolute inset-y-0 h-full` inside a `relative` wrapper.

### Position: inside `SidebarInset`, under the content area

* Good, because it needs no change to `src/renderer/src/components/ui/sidebar.tsx`.
* Bad, because the bar is narrower than the window while the sidebar is open.

### Entry type: `component` draws the whole entry

* Good, because an entry can show anything: a spinner, a count, a menu, a popover.
* Good, because it matches `SidebarSection` and `DialogEntry` in `plugins/dia-layout/slots.ts`, and deepseek-harness's `sidebar.footer.action` list (`packages/client/ui-sidebar/src/client/contract/slots.ts:75` in that repository).
* Bad, because entries from different plugins can look different.

### Entry type: entries are data (`label`, `icon`, `tooltip`, `onClick`)

* Good, because every entry looks the same.
* Bad, because an entry can show only text and an icon, and `dia-layout` draws and owns every variant. Paperclip has no bottom bar; its closest slot, `globalToolbarButton` (`packages/plugins/sdk/README.md:371` in that repository), is a component as well.

### dia's own entries: a `dia-status-bar` plugin

* Good, because dia's own entries can be removed without replacing the window frame (ADR-0019).
* Bad, because it is one more plugin to load at startup.

### dia's own entries: `dia-layout` itself

* Good, because there is no new plugin.
* Bad, because removing dia's own entries means replacing `dia-layout`, the window frame.

### Name: "status bar"

* Good, because VS Code and JetBrains use the term for this row.
* Good, because it does not overlap with "issue" (ADR-0069) or "task kinds" (ADR-0064).

### Name: "task bar"

* Good, because the objective uses the term.
* Bad, because "task" is not a glossary term, org work is called issues (ADR-0069), and a "taskbar" usually means a list of running apps.

## More Information

* ADR-0061 defines list slots.
* Which entries `dia-status-bar` adds first is decided in that plugin's own issue.
