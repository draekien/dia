---
status: "accepted"
date: 2026-11-07
decision-makers: William Pei
---

# List slots: a plugin declares a list it draws, and other plugins add entries to it

## Context and Problem Statement

Two surfaces take entries from many plugins: the session rail's cards (ADR-0048, `addRailCard`) and the content area's pages (ADR-0057, `addPage`). Each is a kernel API with a kernel atom, a kernel entry type (`RailCard`, `Page`) and its own add and remove logic. A third surface, the Settings dialog's pages (#204), would need a third. ADR-0019 makes every feature a plugin, but the kernel owns these lists, so a plugin cannot declare a list of its own, and changing an entry type changes the kernel and `PLUGIN_API_VERSION`. How does a plugin declare a list that other plugins add entries to, typed by the plugin that draws it? (Issue #200.)

## Decision Drivers

* A plugin that draws a list defines the list's entry type, as ADR-0060 lets a provider define a service's type.
* An entry lives for the lifetime of the plugin that adds it and of the plugin that declares the list, and comes back when the declaring plugin reloads, with no reload of the adding plugin.
* No second registry beside the plugin registry (ADR-0031: slots reuse the service-key registry).
* One call per entry for the adding plugin, the same size as `addPage` today.

## Considered Options

* A list slot is a typed service the owning plugin provides; contributors add through `ctx.whenProvided`
* A kernel registry of list names, with its own waiting logic for lists not yet declared
* Keep a kernel API per list (`addPage`, `addRailCard`, `addSettingsPage`)

## Decision Outcome

Chosen option: "A list slot is a typed service the owning plugin provides", because the plugin registry and `whenProvided` (ADR-0056) already give each entry the lifetime the drivers require, and ADR-0060's `ServiceKey` already types a service by a key its provider exports.

* `ListSlot.make<Entry>(name)` from `@dia/plugin` makes a `ServiceKey` for a list whose entries have type `Entry`. The owning plugin makes it in a module it exports (ADR-0059) and prefixes `name` with its plugin name (`layout.pages`).
* `declareList(ctx, slot, { onRemove })`, `addEntry(ctx, slot, entry)` and `useList(slot)` from `@dia/renderer-plugin` declare, add to and read a list. `addEntry` wraps `ctx.whenProvided`, so an entry is added while both the contributor and the owner are loaded, and added again when the owner loads again. It needs no `inject` in `plugin.json`.
* The provided value is opaque; its entries are held by the renderer module that declared it. Only `addEntry` adds an entry, and it records `ctx.name` as the adding plugin, so a plugin cannot add or replace entries under another plugin's name.
* An entry's key is the adding plugin's name and the entry's `id`. Adding the same `id` again from the same plugin replaces the entry. Entries are ordered by `order`, ties by plugin name, then by `id`, so the order does not change when the owner reloads and contributors add their entries again.
* `onRemove` runs after an entry is released while the list is declared, including when the owner itself closes or reloads, and not when an entry is replaced.
* The `chat` plugin owns the session rail's cards (`RailCardsSlot`, `chat.railCards`); the kernel `SessionRail` draws the cards `chat` passes it. A card's saved hide key stays `<plugin>.<id>`.
* The `layout` plugin owns the pages (`PagesSlot`, `layout.pages`). It draws the open page in place of the `main` slot and the page's label as a breadcrumb before the `main.header` slot, and closes an open page whose entry is removed. A plugin that fills `main.header` no longer controls the page breadcrumb.
* An exported module may contain `import type …` and `export type …` statements from `react`, because Node's type stripping (the Host) and the renderer build both erase them. An inline `import { type X } from 'react'` stays forbidden, because Node keeps that statement and loads the package.

This ADR amends ADR-0031 (a slot is a single slot or a list slot), ADR-0057 (the page list belongs to `layout`, and `addPage` is removed) and ADR-0059 (type-only imports from `react` in exported modules), and supersedes ADR-0048.

### Consequences

* Good, because a plugin can declare a list for other plugins with no kernel change; #204 moves Settings pages to a plugin this way.
* Good, because the entry types `Page` and `RailCard` live in the plugins that draw them, so changing them does not change `PLUGIN_API_VERSION`.
* Bad, because a page and its breadcrumb disappear while `layout` is unloaded, and a page that is open when `layout` reloads closes.
* Bad, because a `main.header` filler can no longer draw the page breadcrumb its own way.

## Pros and Cons of the Options

### A kernel registry of list names

* Good, because a list name could be a plain string with no exported module.
* Bad, because it is a second registry beside the plugin registry, with its own logic for entries added before their list is declared.

### Keep a kernel API per list

* Good, because nothing changes for existing plugins.
* Bad, because every new list is a kernel change and a `PLUGIN_API_VERSION` bump, and the kernel defines each entry type.

## More Information

* Spec: `docs/designs/list-slots.md`.
* deepseek-harness solves the same problem with `ctx.slots.inject(key, cb)` per declaration lifetime and entries keyed by `id` and ordered by `order` (`docs/subsystems/slots.md` in that repository).
