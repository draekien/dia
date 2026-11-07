---
status: "accepted, amended by ADR-0065"
date: 2026-11-07
decision-makers: William Pei
---

# Plugins own the Settings dialog, the command palette and their entries

## Context and Problem Statement

The kernel's `main.tsx` mounted `<CommandPalette />` and `<SettingsDialog />`, and both listed fixed pages and commands. A plugin could not add a Settings page, an adapter's settings panel or a palette command. A component a plugin supplied that threw while rendering unmounted the whole window, because nothing caught the error. How do plugins add Settings pages and commands, and what happens when one of their components throws? (Issue #204.)

## Decision Drivers

* A plugin adds a page, panel or command with `addEntry` (ADR-0061), and it goes away when the plugin unloads.
* The palette can find each Settings page and open it, down to a part of a page, such as one adapter.
* A plugin component that throws affects only the area it draws.

## Considered Options

* Settings, the palette and adapter panels as plugins that declare list slots
* Keep both in the kernel and export a registration function for each

## Decision Outcome

Chosen option: "Settings, the palette and adapter panels as plugins that declare list slots", because it reuses ADR-0061's list slots and their unload behaviour and keeps the kernel to the root slot (ADR-0031).

* `layout` declares `DialogsSlot` (`layout.dialogs`) and draws every entry beside the window frame.
* `settings` adds the Settings dialog to `DialogsSlot`, declares `SettingsPagesSlot` (`settings.pages`), and adds General and Plugins.
* `command-palette` adds the palette and the About dia dialog to `DialogsSlot`, declares `CommandsSlot` (`command-palette.commands`), and adds About dia and Toggle Developer Tools.
* `adapters` adds the Adapters page and declares `AdapterPanelsSlot` (`adapters.panels`). `claude-code-settings` adds the Claude Code panel. The `claude-code` adapter cannot add it, because an adapter manifest has no `renderer` entry (ADR-0029). `meta` gains a renderer entry that adds Meta repo.
* Each plugin adds its own palette commands, including a search-only command per Settings page.
* `SettingsLocation` is `{ plugin, id, section? }`: the key of a `SettingsPagesSlot` entry and a part of that page the page interprets. `openSettings` and `openCommandPalette` stay in the kernel and dispatch window events, so kernel code can open either without importing a plugin.
* Every component a plugin supplies renders inside a kernel `PluginBoundary`. In an area of the window, a failed component is replaced by `PluginFailed`, which shows the error, `Try again` and `Open Plugins`. A failed dialog, icon, status line or `main.header` filler renders nothing. A palette command whose `run` throws is reported in an error toast.

This ADR amends ADR-0031.

### Consequences

* Good, because a plugin adds a Settings page or command with one `addEntry`, and unloading the plugin removes it.
* Good, because a plugin component that throws no longer unmounts the window.
* Bad, because with no `layout` plugin loaded there is no Settings dialog and no palette.
* Bad, because Settings › Plugins › Unload still unloads only the Host entry, so a renderer entry's pages stay until restart (`docs/reasoning/2026-11-07-settings-unload-keeps-renderer-entry.md`).

## Pros and Cons of the Options

### Keep both in the kernel and export a registration function for each

* Good, because nothing moves out of `src/`.
* Bad, because each registration function repeats the add, order and unload behaviour that list slots already provide.

## More Information

Spec: `docs/designs/settings-and-palette-plugins.md`. paperclip wraps each plugin slot in `PluginSlotErrorBoundary` (`ui/src/plugins/slots.tsx:739` in `paperclipai/paperclip`), and deepseek-harness wraps each slot entry in `SlotErrorBoundary` (`packages/client/ui-renderer/src/client/scoped-slots.tsx:443` in `deepseek-ai/deepseek-harness`).
