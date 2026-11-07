# List slots

Issue #200. A renderer plugin declares a list slot that it draws; other plugins add entries to it for the lifetime of their scope, typed by a key the owner exports.

## Success criteria

1. Test: plugin `owner` declares a list slot and plugin `contributor` adds two entries; `useList` returns both, ordered by `order`, ties by plugin name then `id`; closing `contributor`'s scope removes both.
2. Test: adding an entry with the same plugin and `id` again replaces it and does not add a second entry.
3. Test: unloading `owner` removes every entry; loading `owner` again shows `contributor`'s entries without reloading `contributor`.
4. Type test: `addEntry(ctx, PagesSlot, { id: 'x', order: 1 })` with `label`, `icon` and `component` missing is a compile error.
5. Packaged app: the sidebar lists "Example" under Meta; selecting it shows the greeting page with its breadcrumb; selecting an agent row closes it.
6. Packaged app: a pane with a session shows the rail cards Context, Background tasks and Task list; hiding a card and showing it again works as before.
7. No `.ts`/`.tsx` file under `src/` or `plugins/` matches `addPage\b`, `addRailCard\b` or `usePages\b` (a grep test).

## Part 1: the list slot API

### `@dia/plugin` (`src/shared/plugin/list-slot.ts`, re-exported from `src/host/plugin-api.ts` only)

Platform-neutral, so an exported plugin module may import it (ADR-0059's import rule). `api.ts` does not import it.

```ts
/** The fields every list entry has. `id` is unique within the adding plugin; lower `order` first. */
export interface ListEntryFields {
  readonly id: string
  readonly order: number
  readonly key?: never
}

/** The plugin that added an entry and the entry's id. */
export interface ListEntryKey {
  readonly plugin: string
  readonly id: string
}

/** An entry as the list holds it: the added fields plus the key of the plugin that added it. */
export type ListEntry<E extends ListEntryFields> = Omit<E, 'key'> & { readonly key: ListEntryKey }

/**
 * The value a list slot's owner provides under the slot's key. It is opaque: plugins add, read and
 * declare only through `addEntry`, `useList` and `declareList`.
 */
export interface ListSlotService<E extends ListEntryFields> {
  readonly _tag: 'ListSlotService'
  readonly _entry?: (entry: E) => E
}

/** A typed list slot key: a `ServiceKey<ListSlotService<E>>` named `name` (ADR-0060). */
export type ListSlot<E extends ListEntryFields> = ServiceKey<ListSlotService<E>>

export const ListSlot = {
  /**
   * A list slot key named `name`, typed by its entry `E`. Make it in a module the owner exports, and
   * prefix `name` with the owner's plugin name (`layout.pages`), because slot names share the
   * service key namespace.
   */
  make: <E extends ListEntryFields>(name: string): ListSlot<E> => ServiceKey.make(name, isListSlotService)
}
```

`isListSlotService` (internal) is `(value: unknown): value is ListSlotService<any>`: it checks `_tag === 'ListSlotService'`. `any` lets `ServiceKey.make` return a key assignable to `ListSlot<E>` without a cast. The guard cannot check `E`; entries are typed by the key only. The optional `_entry` member is never set; it makes `E` invariant, so a key for one entry type does not accept another. `_tag` is a string, so the guard matches a service made by another module instance. The internals are found only by the module instance that declared the list: after a reload of `list-slots.ts` without the owner declaring again, a lookup misses, logs an error (`A list slot service has no internals`), `addEntry` adds nothing and `useList` returns `[]`.

`plugin-api.ts` also gains `export type { PaneId } from '../shared/domain/pane'`, which `plugins/chat/slots.ts` needs.

### `@dia/renderer-plugin` (`src/renderer/src/lib/list-slots.ts`)

```ts
/**
 * Provides list slot `slot` for the lifetime of the plugin's scope; the list starts empty and is
 * discarded when the scope closes. `onRemove` runs after an entry is released while the list is
 * declared — its contributor's scope closed, including when the owner itself closes or reloads,
 * because contributor setups close before their provider — and not when an entry is replaced.
 * Fails with ServiceKeyTakenError when another plugin declares the same slot.
 */
declareList<E extends ListEntryFields>(ctx: PluginServices, slot: ListSlot<E>, options?: { readonly onRemove?: (entry: ListEntry<E>) => Effect<void> })
  : Effect<void, ServiceKeyTakenError | ServiceKeyReservedError, Scope>

/**
 * Adds `entry` to `slot` while both this plugin's scope and the slot's declaration are open. When
 * the owner closes, the entry is released; when the owner declares the slot again, the entry is
 * added again. Adding the same `id` again from the same plugin replaces the entry. Needs no
 * `inject` in plugin.json.
 */
addEntry<E extends ListEntryFields>(ctx: PluginServices, slot: ListSlot<E>, entry: NoInfer<E>): Effect<void, WhenProvidedRefusedError, Scope>

/** The entries of `slot`, ordered by `order`, ties by plugin name then `id`; empty while no plugin declares it. Re-renders on change. */
useList<E extends ListEntryFields>(slot: ListSlot<E>): ReadonlyArray<ListEntry<E>>
```

`entry` is `NoInfer<E>`, so `E` comes from the key only and a missing field is reported on `entry`.

`addEntry` is `ctx.whenProvided([slot], (services) => add(services[slot.name], ctx.name, entry))` (ADR-0056): the entry's lifetime is the intersection of the contributor's scope and the owner's declaration, and an owner reload adds it again. The adding plugin's name always comes from `ctx.name`, so a plugin cannot add or replace entries under another plugin's name. A plugin may add to a list it declares itself: `whenProvided` holds the watcher until the plugin is `Loaded`, then runs it (`plugin-registry.ts` `keysProvided`, `settle`).

`useList` reads the slot's service from the renderer registry and follows `registry.changes` for the slot's name to pick up the service appearing or being withdrawn (the read is suppressed for `noRegistryInject` with the reason `Slot` uses, `slots.ts:68-73`). While a service is present it follows that service's entries, so adding, replacing or removing an entry re-renders. On a withdraw emission it drops its subscription before reading again, so a closed owner's list is never shown.

## Internal Decomposition

- **`list-slot.ts` (shared)** — the key type, the opaque service type and the guard. Knows nothing about React, the registry or the entries.
- **`list-slots.ts` (renderer)** — a module-level `WeakMap<ListSlotService<any>, ListInternals>` holds each service's internals, so only this module can add or read entries:
  - `ListInternals` holds the entries in a `SubscriptionRef`, sorted by `order`, then `key.plugin`, then `key.id`, and the owner's `onRemove`.
  - `add(service, plugin, entry)` is `Effect.acquireRelease`. Acquire: put the entry under `{ plugin, id }`, replacing any entry with that key; log at debug `Added a list entry` or `Replaced a list entry` with `{ slot, plugin, id }`. Release: remove the entry only if the list still holds this exact object (identity, as `pages.ts:56` does with `existing !== entry`), so the release of a replaced add does not remove its replacement; then run `onRemove(entry)` and log `Removed a list entry`.
  - `declareList` builds `{ _tag: 'ListSlotService' }`, registers its internals and `ctx.provide`s it under the key.
  - `addEntry` is the `whenProvided` call above; `useList` is the React hook above.

## Part 2: rail cards owned by `chat`

- `plugins/chat/slots.ts` (new, listed in `plugin.json` `exports`):
  ```ts
  import { ListSlot, type PaneId } from '@dia/plugin'
  import type { ComponentType } from 'react'
  /** A card on the session rail; the rail draws the frame and header, `component` the body. */
  export interface RailCard { readonly id: string; readonly order: number; readonly title: string; readonly component: ComponentType<{ readonly paneId: PaneId }> }
  /** The session rail's cards, declared by `chat`. Add a card with `addEntry(ctx, RailCardsSlot, card)`. */
  export const RailCardsSlot = ListSlot.make<RailCard>('chat.railCards')
  ```
- `plugins/chat/renderer.ts`: `declareList(ctx, RailCardsSlot)`, then three `addEntry` calls with `order` 10 (Context), 20 (Background tasks), 30 (Task list) — today's insertion order.
- `plugins/chat/pane.tsx` passes `useList(RailCardsSlot)` to `<SessionRail paneId cards />`.
- Kernel `session-rail.ts` declares `RailCardView = ListEntry<{ id: string; order: number; title: string; component: ComponentType<{ readonly paneId: PaneId }> }>`, which `chat`'s entries are assignable to, and exports `railCardKey(card) = `${card.key.plugin}.${card.key.id}``. A card's hide key stays that string (`chat.context`), so cards a user hid stay hidden.
- Kernel `session-rail.tsx`: `SessionRail` takes `cards: ReadonlyArray<RailCardView>` and passes them through `RailCardFrame` to `CardMenu`, which no longer reads an atom.
- Kernel `session-rail.ts` drops `railCardsAtom`, `visibleRailCardsAtom`, `RailCard`, `RegisteredRailCard` and `addRailCard`. `useRailCardShown(key)` becomes `railShown && !hidden.includes(key)`.

## Part 3: pages owned by `layout`

- `plugins/layout/slots.ts` (new, exported):
  ```ts
  import { ListSlot } from '@dia/plugin'
  import type { ComponentType } from 'react'
  /** A page in the content area, listed in the sidebar; `component` renders the body. */
  export interface Page { readonly id: string; readonly order: number; readonly label: string; readonly icon: ComponentType<{ readonly className?: string }>; readonly component: ComponentType }
  /** The content area's pages, declared by `layout`. Add a page with `addEntry(ctx, PagesSlot, page)`. */
  export const PagesSlot = ListSlot.make<Page>('layout.pages')
  ```
- `plugins/layout/renderer.ts` (imports `actions`, `declareList` and `fillSlot` from `@dia/renderer-plugin`): `declareList(ctx, PagesSlot, { onRemove: (entry) => Effect.sync(() => actions.closePage(entry.key)) })`, then `fillSlot(ctx, ROOT, Layout)`. A reload of `layout` therefore closes an open page, as a reload of a page's own plugin does today (ADR-0057).
- `plugins/layout/layout.tsx`: when the view is a `PageView` whose key is in `useList(PagesSlot)`, the content area renders the page's `component` instead of `<Slot name={MAIN}/>`, and the header row renders the page's label as a one-item breadcrumb before `<Slot name={MAIN_HEADER}/>`, using the shadcn breadcrumb primitives. A `PageView` whose key is not in the list renders `<Slot name={MAIN}/>`, which shows an empty content area; `onRemove` closes such a view. A plugin that fills `main.header` no longer controls the page breadcrumb; the ADR states this.
- Kernel `TabContent` returns `null` for a `PageView`; kernel `TabHeader` draws no breadcrumb for it (it still draws `WindowStatus`).
- `plugins/agent-overview/agent-overview.tsx` `PagesGroup` reads `useList(PagesSlot)`.
- `plugins/example/renderer.ts`: `addEntry(ctx, PagesSlot, { id: 'greeting', order: 10, label: 'Example', icon: HandIcon, component: GreetingPage })`.
- `actions.ts` gains `closePage(key)`, also added to the `actions` object in `plugin-api.ts`: when the open page's key equals `key`, it clears `openPageAtom` and calls `window.dia.selectTab(shownBefore)` when `shownBefore !== null`, as `cancelNewAgent` does; otherwise it does nothing. `pages.ts` (`addPage`, `usePages`, `pagesAtom`, `findPage`, `Page`, `RegisteredPage`) is removed; `PageKey` and `PageView` stay in `view.ts`.
- `@dia/renderer-plugin` exports `declareList`, `addEntry`, `useList`, and the shadcn breadcrumb primitives (`export * from './components/ui/breadcrumb'`); it stops exporting `addPage`, `usePages`, `Page`, `RegisteredPage`, `addRailCard`, `RailCard`.
- Invoke the `shadcn` and `impeccable` skills before editing `layout.tsx` and the breadcrumb export (`src/renderer/CLAUDE.md`).

## Part 4: exported modules may import types from `react`

`plugins/*/slots.ts` needs `import type { ComponentType } from 'react'`. ADR-0059 lets an exported module import only `effect`, `@dia/plugin` and other exported modules, and `plugin-exports.test.ts` counts `import type` lines (`SPECIFIER_PATTERNS`). The rule changes to: an `import type … from 'react'` or `export type … from 'react'` statement, on one line or several, is allowed, because the Host's Node type stripping and the renderer build both erase it. Value imports keep the ADR-0059 rule, and any other package stays rejected. An inline `import { type X } from 'react'` stays forbidden, because Node keeps the statement and loads the package.

- `plugin-exports.test.ts`: the specifier check skips type-only statements from `react`; fixtures cover the single-line, multi-line and `export type` forms, and the inline form is rejected.
- A child-process test in `plugin-modules.test.ts` loads an exported module with `import type { ComponentType } from 'react'` through the Host loader and succeeds. (Unverified until that test runs: that Node's type stripping removes the whole statement.)
- `vite/plugin-exports.ts` resolves only `@dia-plugin/*` specifiers and needs no change.

## Versions and records

- `PLUGIN_API_VERSION` 0.0.24 → 0.0.25 and every `plugins/*/plugin.json` `api`. `DiaRpcs` and `PROTOCOL_VERSION` unchanged.
- ADR-0061 "List slots: a plugin declares a list it draws and others add entries to it": amends ADR-0031 (slot kinds: `single` and `list`), ADR-0057 (the page list belongs to `layout`; a `main.header` filler no longer controls the page breadcrumb), ADR-0059 (type-only imports from `react` in exported modules); supersedes ADR-0048. Added to `docs/adr/README.md`, and the amended ADRs' status lines updated.
- `tsconfig.plugin-exports.json` and `tsconfig.web.json` include `plugins/chat/slots.ts` and `plugins/layout/slots.ts`.
- `DESIGN.md:98` and `:141` (pages and rail cards: how they are added; rail card order is by `order`), `docs/designs/plugin-pages-and-messages.md` and `docs/designs/session-rail.md` are updated to the list slots.

## Tests

| Criterion | Test |
| --- | --- |
| 1, 2, 3 | `src/renderer/src/lib/list-slots.test.ts` over a real `makePluginRegistry` with two plugins, owner and contributor; also: a plugin adds to a list it declares itself; `onRemove` runs on contributor close and not on replace; the release of a replaced entry does not remove the replacement; ties sort by plugin then id |
| 4 | type test in `list-slots.test.ts` with `// @ts-expect-error` |
| 5, 6 | `verify-in-app`, packaged build |
| 7 | `src/renderer/src/lib/list-slot-migration.test.ts` greps `src/` and `plugins/` for `.ts`/`.tsx`, skipping its own file |
| type-only imports | `plugin-modules.test.ts` child process, `plugin-exports.test.ts` fixtures |
| migrated | `pages.test.ts` is renamed `page-actions.test.ts`, keeps its `openPage`/`selectTab` cases and gains `closePage` (open a page over tab P, `closePage` selects P; another key changes nothing); its add/remove cases move to `list-slots.test.ts`. `session-rail.test.ts` and `session-rail.test.tsx` pass cards as a prop instead of `addRailCard` |

## Design Rationale

**A list is a typed service the owner provides** — the user chose this (option A). Owner lifetime, contributor lifetime and owner-reload replay come from the plugin registry and `whenProvided`; there is no second registry, keeping ADR-0031's "slots reuse the service-key registry".

**The service is opaque, its internals in a renderer `WeakMap`** — the key is public, so any plugin can receive the service; an opaque value means only `addEntry` (which takes the plugin name from `ctx`) can add, and nobody can add under another plugin's name (Information Hiding).

**The list publishes its own changes** — the registry's `changes` reports a key being provided or withdrawn, not a change inside a provided value.

**Ties sort by plugin then id, with no insertion sequence** — the list is rebuilt on an owner reload and contributors re-add in watcher order, so an insertion sequence would reorder equal-`order` entries after a reload. A stable key order does not depend on reload history.

**`addEntry` wraps `whenProvided`** — a contributor writes one call, the same size as `addPage` today, and cannot forget to wait for the owner.

**`ListSlot` lives in `@dia/plugin`, the helpers in `@dia/renderer-plugin`** — the key must be importable from an exported module (ADR-0059), so it is platform-neutral; `useList` is React, and only the renderer draws entries.

**`onRemove` on `declareList`** — the owner decides what removal means for its surface; `layout` closes an open page whose entry went, which `addPage` did in the kernel before.

**The page breadcrumb moves to `layout`** — the kernel cannot import `PagesSlot`, so it cannot find a page's label; `layout` owns the list and draws the label. No shipped plugin fills `main.header`.

**Hide keys stay `<plugin>.<id>`** — users' saved hidden rail cards (`localStorage` `dia.rail.hidden`) keep working.

**Type-only imports only from `react`** — the one package the entry types need; a wider rule would let unchecked types become `any` under `skipLibCheck`.

## Rejected Alternatives

- **A kernel name registry** (option B) — a second registry with its own waiting logic; the user chose A.
- **Two lists per page (sidebar entry and content), as deepseek-harness does** — two calls per page for no current need; the user chose one list.
- **Moving the Settings dialog** — issue #204.
- **Keeping `Page` and `RailCard` in the kernel** — the kernel cannot import a plugin's key, and the owner should define what its entries are.
- **Keeping the page breadcrumb in the kernel `TabHeader`, fed by a kernel atom `layout` writes** — a second copy of the page label held for one reader.

## Refinement Record

### Round 1

Applied:
- *Correctness* (blocker) — `useList` followed only `registry.changes`, which fires on provide and withdraw, not on an add (`plugin-registry.ts:518-530`). The list publishes its own changes.
- *Correctness* (blocker) — an empty `ListSlotService<E>` left `E` phantom, so criterion 4 would compile. `E` is carried by the type (now `_entry`, round 2).
- *Design principles* (blocker) — the draft pointed at a missing "Internal Decomposition"; added, with the identity rule for releases of replaced entries.
- *Correctness* (major) — `onRemove` also runs when `layout` reloads, because contributor setups close before their provider (`plugin-registry.ts:749-776`). Stated; a `layout` reload closes an open page.
- *Correctness* (major) — `ListEntry<RailCard-shaped>` was undefined; the kernel declares a structural `RailCardView`.
- *YAGNI* (major) — type-only imports narrowed from any package to `react`.
- *Project rules* (major) — re-exporting from `api.ts` would create a cycle with `list-slot.ts`; export from `src/host/plugin-api.ts` only.
- *Minor* — the grep test skips its own file; a `PageView` with a missing page is stated; the `shadcn` and `impeccable` skills are named.

### Round 2

Applied:
- *Correctness* (blocker) — `PaneId` is not exported from `@dia/plugin` (`plugin-api.ts:49` exports only `SessionId`); added.
- *Information Hiding* (major) — `add(plugin, entry)`, `entries` and `changes` on the provided value let any plugin add under another plugin's name. The service is opaque, internals in a renderer `WeakMap`.
- *Correctness* (major) — an insertion sequence reorders equal-`order` entries after an owner reload; ties sort by plugin then id. Criterion 1's tie order changes accordingly (put to the user at the gate).
- *Correctness* (major) — generic signatures lacked `extends ListEntryFields`; `ListEntryFields` gains `key?: never` so `ListEntry` cannot collide.
- *Correctness* (major) — the breadcrumb leaves the `main.header` slot; the behaviour change is stated in the ADR.
- *Minor* — slot names prefixed with the owner (`layout.pages`, `chat.railCards`); `useList` drops a withdrawn service before re-reading; migrated tests and stale docs listed; `railCardKey` and the `CardMenu` prop path stated.

### Round 3

Applied:
- *Correctness* (blocker) — clearing `openPageAtom` alone leaves no tab selected, because `openPage` calls `selectTab(null)` (`actions.ts:45-54`). `closePage` restores `shownBefore` as `cancelNewAgent` does (`actions.ts:56-62`), with a test.
- *Correctness* (major) — the `WeakMap` is per module instance; a lookup miss after a reload of `list-slots.ts` was undefined. It logs an error, `addEntry` adds nothing, `useList` returns `[]`.
- *Minor* — `entry: NoInfer<E>` (TypeScript 7.0.2 supports it); `layout`'s `actions` import stated; `pages.test.ts` renamed `page-actions.test.ts`.

Checked clean: guard assignability without a cast (`api.ts:26-40`); criterion 4 fails to compile; `Page` without `key` satisfies `ListEntryFields`; `whenProvided` passes the provided object without copying, so the `WeakMap` lookup works; `pages.ts` importers (`tab-content.tsx`, `tab-header.tsx`, `plugin-api.ts`, `pages.test.ts`) are all covered; `closePage` collides with no name.

Rounds stopped: the budget of 3 is spent.
