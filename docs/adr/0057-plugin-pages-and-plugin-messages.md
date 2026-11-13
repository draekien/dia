---
status: "accepted, amended by ADR-0061, ADR-0068 and ADR-0074"
date: 2026-11-07
decision-makers: William Pei
---

# Let a renderer plugin add pages, and let a plugin's renderer entry call its own host entry over one `CallPlugin` RPC

## Context and Problem Statement

The org screens (issue #178) need a screen of their own in the content area and data from the `org` plugin's host entry. A renderer plugin can fill slots (ADR-0031) and add rail cards (ADR-0048), but it cannot add a screen to the content area. ADR-0022 lists "a plugin's `host` and `renderer` entries exchange messages over the same connection, namespaced by plugin name", but no code implements it. How does a renderer plugin add a screen, and how does it call its own host entry?

## Decision Drivers

* Several plugins add pages, and one plugin can add several, so a single-filler slot does not fit (ADR-0031).
* A page's sidebar entry and its content must disappear when the plugin's scope closes.
* A call must cross the existing renderer-to-Host connection (ADR-0022) and carry typed payloads, results and errors that both entries share.
* A call made while the host entry is not loaded must fail with a typed error.
* References: deepseek-harness pairs a keyed `main` slot entry with a `sidebar.panellist` entry (`packages/client/ui-schedule/src/client/index.ts:218-246`) and mounts a per-plugin remote (`packages/experimental/client-ui-action-cards/src/client/mount.ts:36-48`); paperclip proxies `usePluginData` / `usePluginAction` by key (`ui/src/plugins/bridge.ts`).

## Considered Options

* Pages: a kernel page list, like rail cards; a `page` slot kind.
* Messages: one generic `CallPlugin` RPC with calls declared by `Rpc.make`; a per-plugin `RpcGroup` over a nested protocol.

## Decision Outcome

Chosen options: "a kernel page list" and "one generic `CallPlugin` RPC", because the user chose them (2026-11-07). The design is `docs/designs/plugin-pages-and-messages.md`.

| Rule | Value |
| --- | --- |
| Adding a page | `addPage(ctx, { id, label, icon, order, component })` from `@dia/renderer-plugin` adds the page for the lifetime of the plugin's scope; its key is the plugin name and `id` |
| Sidebar | `plugins/agent-overview` lists `usePages()` under the Meta group, sorted by `order`, hidden while a search or filter applies |
| View | `View` gains `PageView { plugin, id }`; `viewOf` shows the open page before the New agent form and the visible tab. `actions.openPage` opens it; selecting a tab, New agent, a different visible tab, or the page's removal (unload or reload) closes it |
| Declaring a call | `Rpc.make(tag, { payload, success, error })` in a module both entries import; a struct `payload`, never a stream (amended by ADR-0068: a streaming call is declared with `stream: true`) |
| Serving | `ctx.serve(rpc, handler)` on the host context, for the lifetime of the scope it runs in. The handler is provided through the plugin registry under a private key, so withdrawal, `whenProvided` scoping and leases (ADR-0055) come from the registry |
| Calling | `callHost(ctx, rpc, payload)` from `@dia/renderer-plugin` calls the host entry of the plugin named `ctx.name` only (amended by ADR-0074: `callHost(name, rpc, payload)` calls any plugin's host entry) |
| Wire | `DiaRpcs` gains the query `CallPlugin { plugin, tag, payload }` (amended by ADR-0074: it also carries `call: { id, resent }`, the same `id` on every resend); values are encoded with the call's own schemas. Errors: `PluginNotServing`, `PluginCallInvalid`, and the handler's own error |

### Consequences

* Good, because a plugin defines a call's schemas once and both entries type-check against them.
* Good, because `DiaRpcs` changes once, not for each plugin.
* Good, because a page needs one call in a renderer setup, and the kernel draws its header and sidebar entry.
* Bad, because `CallPlugin` is resent while the connection is down, so a handler can run more than once and must be safe to repeat; there is no `commandId` because a plugin call has no target the Host deduplicates on.
* Bad, because calls are request/response only; a streaming call needs a second generic RPC.
* Bad, because a reload closes an open page.
* Bad, because the plugin context gains exports, so `PLUGIN_API_VERSION` goes from 0.0.21 to 0.0.22, and `PROTOCOL_VERSION` from 0.0.24 to 0.0.25.

## Pros and Cons of the Options

### A kernel page list

* Good, because it follows the rail-card shape (ADR-0048): many contributors and cleanup when the scope closes.
* Bad, because it is a third extension mechanism next to slots and rail cards.

### A `page` slot kind

* Good, because it reuses the slot registry.
* Bad, because slots hold one filler each (ADR-0031), and listing pages in the sidebar needs a second registration anyway.

### One generic `CallPlugin` RPC

* Good, because it is one RPC, a handler key in the existing registry, and two helper functions.
* Bad, because no streaming.

### A per-plugin `RpcGroup` over a nested protocol

* Good, because it supports streaming.
* Bad, because it adds a second protocol inside the first, with a client and server per plugin.

## More Information

* Amends ADR-0031 (a third extension mechanism, pages) and implements ADR-0022's "Plugin messages" row.
* Related: ADR-0032 (plugin API version), ADR-0048, ADR-0055, ADR-0056.
