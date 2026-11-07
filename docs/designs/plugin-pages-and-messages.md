# Plugin pages and plugin messages

Issue: draekien/dia#194. Blocks #178 (org screens).

Lets a renderer plugin add pages to the content area, listed in the sidebar, and lets a plugin's `renderer` entry call its own `host` entry over the existing renderer-to-Host connection (ADR-0022 "Plugin messages" row).

## Success criteria

1. With `plugins/example` loaded, the sidebar lists an "Example" page; selecting it shows a page whose text is a value the renderer entry read from the host entry.
2. Pages with `order` 20 and 10 are listed 10 then 20.
3. Unloading a plugin while its page is shown removes its sidebar entry, and the content area shows what `viewOf` returns with no page open.
4. A call made while the plugin's `host` entry is not loaded fails with `PluginNotServing`.
5. A handler's typed error reaches the renderer as the same error, decoded by the shared schema.
6. Once the `host` entry's scope closes, its handlers are withdrawn, so criterion 4 applies.

## Part 1: pages

### Interface (`@dia/renderer-plugin`)

```ts
/** A page a plugin adds to the content area with {@link addPage}. */
export interface Page {
  /** Unique within the plugin, for example `greeting`. */
  readonly id: string
  /** The sidebar entry's text and the content header's breadcrumb, for example `Example`. */
  readonly label: string
  /** The sidebar entry's icon, for example a `lucide-react` icon component. */
  readonly icon: ComponentType<{ readonly className?: string }>
  /** Sort position in the sidebar; lower first. Ties keep the order pages were added. */
  readonly order: number
  /** Renders the page body; the kernel draws the content header. */
  readonly component: ComponentType
}

addPage(ctx: PluginServices, page: Page): Effect<void, never, Scope>
usePages(): ReadonlyArray<RegisteredPage>    // sorted by `order`
actions.openPage(key: PageKey): void         // shows the page
```

`RegisteredPage` is `Page` plus `key: PageKey`.

### Key data structures

```ts
// src/renderer/src/lib/view.ts
export const PageKey = Schema.Struct({ plugin: PluginName, id: Schema.String })
export const PageView = Schema.TaggedStruct('PageView', PageKey.fields)
export const View = Schema.Union([PageView, TabView, NewAgentView, FirstRunView, EmptyProjectView])

/** The open page and the tab that was visible when it opened. */
export interface OpenPage { readonly key: PageKey; readonly shownBefore: PaneId | null }
```

`viewOf(workspace, form, page: Option<OpenPage>)` priority: the open page, else the form, else the visible tab, else first-run, else empty project. `undefined` until the workspace loads, as now.

### Module layout

- `src/renderer/src/lib/view.ts` — `PageKey`, `PageView`, `OpenPage`, `viewOf`, `closesOpenPage`.
- `src/renderer/src/lib/workspace-atoms.ts` — `openPageAtom: Option<OpenPage>` beside `newAgentFormAtom`; `viewAtom` reads it.
- `src/renderer/src/lib/pages.ts` — `Page`, `RegisteredPage`, `pagesAtom`, `addPage`, `usePages`.
- `src/renderer/src/lib/actions.ts` — `openPage`. `cancelNewAgent` needs no page case: opening a page closes the form.
- `src/renderer/src/components/tab-content.tsx` — a `case 'PageView'` in its switch, the only exhaustive switch on `View`; its JSDoc lists pages. `tab-header.tsx` tests `_tag` with `if` and gains the page branch; `plugins/chat` reads `useView` and needs no change.

### Behaviour

| Event | Effect on `openPageAtom` |
| --- | --- |
| `actions.openPage(key)` | `some({ key, shownBefore })`, where `shownBefore` is the open form's `shownBefore` when the New agent form is open, else the open page's `shownBefore` when a page is open, else `visibleTab`. `newAgent` takes its `shownBefore` the same way, so cancelling the form returns to the tab a page hid. Then closes the form and calls `window.dia.selectTab(null)`, as `newAgent` does, so no tab counts as visible (or highlighted) behind the page |
| `actions.selectTab`, `actions.newAgent` | `none` |
| A workspace change whose `visibleTab` is non-null and differs from `shownBefore` (a notification click, a Host-side switch) | `none` (`closesOpenPage`, as `closesNewAgentForm`) |
| The page's plugin unloads or reloads (`addPage`'s release) | `none` when it names that page |
| Restart | `none` (not persisted) |

`addPage` follows `addRailCard` (ADR-0048): `Effect.acquireRelease` over the kernel atom `pagesAtom`, keyed `<plugin>.<id>`; the release removes the entry by identity and clears `openPageAtom` when it names the entry's key. A reload therefore closes an open page; the user lands on what `viewOf` returns without it.

The kernel `main` default (`TabContent`) renders `PageView` as the registered page's `component`; `TabHeader` renders a `BreadcrumbList` with one `BreadcrumbPage` holding the page `label`: a second branch beside `Crumbs`, which needs a project (`tab-header.tsx:38`).

`plugins/agent-overview` renders `usePages()` as a `SidebarGroup` under the Meta group, one `SidebarMenuButton` per page (icon + label; `isActive` while its page is the view). It is hidden while a search or filter applies, like Meta. In the collapsed rail each page is its icon after the Meta marker, with the label as tooltip.

## Part 2: plugin messages

A plugin declares each call once with `Rpc.make` from `effect/rpc` in a module both its entries import:

```ts
// plugins/example/messages.ts
export const ReadGreeting = Rpc.make('ReadGreeting', { payload: {}, success: Schema.String })
```

### Interface

Host (`HostPluginContext`, so `@dia/plugin`):

```ts
/**
 * Serves `rpc` for calls from this plugin's own `renderer` entry until the scope it runs in closes.
 * The handler can run more than once for one `callHost`, and the runs can overlap: the renderer
 * resends a call while the Host connection is down, and the first run is not cancelled. Make it
 * safe to repeat. Closing the scope waits up to `SERVICE_USE_TIME_LIMIT` for running handlers,
 * then interrupts them; the caller then sees `PluginNotServing` although the handler may have
 * partly run. Serving a tag this plugin already serves in
 * an open scope, serving a tag another plugin has taken, and serving a streaming `rpc` are defects.
 */
readonly serve: <R extends Rpc.AnyWithProps>(
  rpc: R,
  handler: (payload: Rpc.Payload<R>) => Effect<Rpc.Success<R>, Rpc.Error<R>>
) => Effect<void, never, Scope>
```

Inside `whenProvided`, the handler is withdrawn with that child scope.

Renderer (`@dia/renderer-plugin`):

```ts
/**
 * Calls `rpc` on the `host` entry of the plugin named `ctx.name`. Fails with `PluginNotServing`
 * while that entry is not loaded or does not serve `rpc`, and with `PluginCallInvalid` when the
 * two entries disagree on `rpc`'s schemas. A defect in the handler is a defect here.
 */
callHost<R extends Rpc.AnyWithProps>(
  ctx: PluginServices,
  rpc: R,
  payload: Rpc.PayloadConstructor<R>
): Effect<Rpc.Success<R>, Rpc.Error<R> | PluginNotServing | PluginCallInvalid>
```

### Errors (`src/shared/plugin/messages.ts`, exported from both plugin APIs)

```ts
/** No handler for `tag` is served by plugin `plugin`: its host entry is not loaded, does not serve `tag`, or closed during the call (the handler may then have partly run). */
class PluginNotServing extends Schema.TaggedError<PluginNotServing>()('PluginNotServing', { plugin: PluginName, tag: Schema.String, message: Schema.String }) {}
/** The payload or result did not match the schema on the receiving side (the two entries disagree on `rpc`, for example after only one was reloaded). */
class PluginCallInvalid extends Schema.TaggedError<PluginCallInvalid>()('PluginCallInvalid', { plugin: PluginName, tag: Schema.String, message: Schema.String }) {}
/** Wire only: the handler's error, encoded with `rpc.errorSchema`. Exported from `src/shared/plugin/messages.ts` only; neither plugin API re-exports it. */
class PluginCallFailed extends Schema.TaggedError<PluginCallFailed>()('PluginCallFailed', { error: Schema.Unknown }) {}
```

### Wire

`DiaRpcs` gains one query; `PROTOCOL_VERSION` 0.0.24 → 0.0.25; the `DiaRpcs` JSDoc lists `CallPlugin` among the queries that take no `commandId` and are resent:

```ts
Rpc.make('CallPlugin', {
  payload: { plugin: PluginName, tag: Schema.NonEmptyString, payload: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Union([PluginNotServing, PluginCallInvalid, PluginCallFailed])
})
```

`payload` and `success` carry values encoded with the rpc's own schemas, so `Schema.Unknown` passes JSON-safe encoded values only. Every `rpc` a plugin serves declares a struct payload (`payload: {}` when it takes none), so the wire payload is a JSON object, never `undefined`. `CallPlugin` is a query with no wrapper field; a test sends a plugin payload that has its own `payload` and `plugin` fields and asserts the handler receives them unchanged.

`window.dia.plugins.call(plugin, tag, payload): Promise<PluginCallResultJson>` in the preload resolves `{ _tag: 'Success', value }` or `{ _tag: 'Failure', error }` with the three errors as plain data, following `activities.run`; a defect rejects the promise, as every `query` does.

### Internal decomposition

- **`src/shared/plugin/messages.ts`** — the error schemas only.
- **`src/host/plugins/plugin-messages.ts`** — the Host side. `servePluginCall(services, served, rpc, handler)` wraps the handler (decode payload → run → encode success, or encode error into `PluginCallFailed`; a decode failure is `PluginCallInvalid`), brands it with a module-private symbol, and in one `Effect.acquireRelease` adds the tag to the plugin's `served` set (created in `extend`, so each open starts empty) and removes it on release, then `provide`s the handler under the private key `call:<plugin>.<tag>` (plugin names contain no `.`). A tag already in `served`, a stream `successSchema` (`RpcSchema.isStreamSchema`), and every `provide` failure (`ServiceKeyTakenError` from another plugin's `call:` key; `ServiceKeyReservedError`, which `call:` keys never hit) are defects. `callPlugin(registry, request)` leases the handler with `registry.use` (ADR-0055); `Option.none`, a value without the brand, and `ServiceWithdrawnError` become `PluginNotServing`. `host-plugins.ts` adds `serve` to the context in `extend`; `rpc-handlers.ts` adds `CallPlugin`.
- **`src/renderer/src/lib/plugin-messages.ts`** — the renderer side: `callHost` encodes the payload, calls `window.dia.plugins.call`, and decodes the success or error with the rpc's schemas; a decode failure is `PluginCallInvalid`.

### Example plugin

`plugins/example/plugin.json` gains `"load": "eager"` so its host entry is loaded before the page first renders. `host.ts` serves `ReadGreeting`; `renderer.ts` adds a page whose component calls `callHost(ctx, ReadGreeting, {})` and shows the greeting, or the error's `message` when the call fails. The component runs `callHost` with `Effect.runPromise` in a `useEffect` and ignores a result that arrives after unmount; unmounting does not cancel the Host handler.

### Design rationale

**Handlers live in the plugin registry, not a second table.** `serve` provides the wrapped handler under a private key, as `fillSlot` does for slots (ADR-0031). Withdrawal when the scope closes, scoping inside `whenProvided`, and closing waiting for in-flight calls (ADR-0055) come from the registry. The brand makes a value another plugin provides under a `call:` key `PluginNotServing` instead of a defect.

**One generic RPC.** Chosen by the user over a per-plugin `RpcGroup` (nested protocol): request/response covers #178, and `DiaRpcs` changes once instead of per plugin.

**Shared `Rpc.make` definitions.** The plugin writes payload, success and error schemas once; both entries import them by relative path. No new dia type for a "plugin message" (Strategic Programming: the concept is effect's).

**The caller names no plugin.** `callHost` takes `ctx` and uses `ctx.name`, so a renderer entry can only call its own host entry.

**`PageView` in `View`; the page closes with its plugin's scope.** Pages are content-area views like tabs, so `useView` callers switch on one union. A reload releases before it re-adds (`closeWithDependants` runs before `open`), so it closes an open page too. Keeping the page open across a reload would need the open page to outlive its registration, and then a permanent unload leaves a stale open page that reappears when the plugin loads again; reloads are a development action, so closing is the simpler correct rule.

## Rejected alternatives

**Per-plugin `RpcGroup` over a nested protocol** — rejected by the user: a second protocol to maintain, and streaming is not needed by #178.

**A kernel handler map beside the registry** — rejected: re-implements withdrawal and leases that `ctx.provide` / `registry.use` already give.

**A `page` slot kind** — rejected: slots are single-filler (ADR-0031); many plugins add pages, which is the rail-card shape (ADR-0048).

**A `commandId` on `CallPlugin`** — rejected: the Host deduplicates commands per target, and a plugin call has no target dia knows; handlers are documented as safe to repeat instead.

## Records

- New ADR `0057-plugin-pages-and-plugin-messages.md` and its row in `docs/adr/README.md`: amends ADR-0031 (pages, a second many-contributor extension) and implements ADR-0022's "Plugin messages" row. ADR-0031's status becomes "accepted, amended by ADR-0038, ADR-0040 and ADR-0057".
- This spec at `docs/designs/plugin-pages-and-messages.md`.
- `PLUGIN_API_VERSION` 0.0.21 → 0.0.22 and every shipped `plugin.json` `api` (ADR-0032).
- `PROTOCOL_VERSION` 0.0.24 → 0.0.25.
- DESIGN.md Agent Overview: a "Pages" bullet.

## Refinement Record

**Applied (round 1)**
- *Correctness* — `Schema.TaggedErrorClass` does not exist (`Schema.ts:16775` has `TaggedError`); errors use `Schema.TaggedError`, and `PluginCallFailed` gained a tag.
- *Correctness* — same-plugin double `provide` succeeds outside `whenProvided` (`plugin-registry.ts:462-477`); `serve` tracks served tags per plugin.
- *Correctness* — a visible-tab change from the Host would stay hidden behind an open page; `OpenPage.shownBefore` and `closesOpenPage` added.
- *Correctness* — a reload releases before it re-adds (`plugin-registry.ts:885`), so clearing on release closed the page on every reload; `viewOf` now skips an unregistered open page, and release removes by identity.
- *Correctness* — lazy loading can leave the host entry unloaded on first render; the example loads eagerly and shows the error message.
- *Correctness* — resends run a handler twice; stated on `serve`, and a `commandId` alternative recorded as rejected.
- *Correctness* — `Rpc.Any` has no schemas (`Rpc.ts:241`); bound is `Rpc.AnyWithProps`.
- *Correctness* — handler defects stated as defects on `callHost`; `DiaRpcs` JSDoc update listed.
- *Project rules* — RPC wrapper-field rule restated as the test it requires.
- *Project rules* — ADR index row and spec path added to Records.
- *Names* — `PageView` reuses `PageKey.fields`; `plugin` is `PluginName`.
- *Define Errors Out of Existence* — another plugin can provide a `call:` key; handlers are branded and an unbranded value is `PluginNotServing`.
- *Information Hiding* — the `call:` key format moved from `src/shared` to the Host module.
- *Define Errors Out of Existence* — `ServiceKeyReservedError` dropped from `serve`'s signature.
- *Module layout* — homes named for `openPageAtom` (avoids the `appRegistry` import cycle) and the pages module.
- *Correctness* — breadcrumb markup: `Crumbs` requires a project (`tab-header.tsx:38`); a page renders its own one-item `BreadcrumbList`.

**Applied (round 2)**
- *Correctness* — `Rpc.make` defaults `payload` to `Schema.Void` (`Rpc.ts:944`), so `callHost(ctx, ReadGreeting, {})` did not type-check and `undefined` reached the wire; plugin rpcs declare a struct payload.
- *Correctness* — the `served` set had no release, so a re-run `whenProvided` setup could not serve again; the tag is removed in the same `acquireRelease`.
- *Correctness* — keeping an unregistered open page let a permanently unloaded page reappear on a later load; reverses round 1's choice: the release clears the open page, and a reload closes it.
- *Correctness* — a streaming rpc type-checks; `serve` dies on `RpcSchema.isStreamSchema` (`RpcSchema.ts:31`).
- *Project rules* — `PluginCallFailed`'s export scope stated.
- *Define Errors Out of Existence* — `serve` returns `Effect<void, never, Scope>`; collisions are programming errors, so defects.

**Applied (round 3)**
- *Correctness* — `newAgent` sets the Host's visible tab to `null` (`actions.ts:30`), so a page opened from the form recorded `shownBefore: null` and dropped the form's; `openPage` keeps the form's `shownBefore` and also clears the Host's visible tab.
- *Correctness* — `tab-content.tsx:73-92` is the only exhaustive `View` switch; named in Module layout with the JSDoc updates.
- *Correctness* — how a component runs `callHost`, and that unmount does not cancel the handler, stated.
- *Correctness (code review)* — a page opened over a page, or New agent opened over a page, took `visibleTab` (`null` behind a page) as `shownBefore`; both now take the open page's `shownBefore`. The release keeps the page open while another entry with its key is still registered.
- *Correctness* — overlapping runs and the `SERVICE_USE_TIME_LIMIT` interrupt (`plugin-registry.ts:599`) stated on `serve` and `PluginNotServing`.
