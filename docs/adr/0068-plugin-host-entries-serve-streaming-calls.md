---
status: "accepted"
date: 2026-11-08
decision-makers: William Pei
---

# Plugin host entries serve streaming calls, and a subscription holds no lease

## Context and Problem Statement

ADR-0057 lets a plugin's renderer entry call its host entry with `callHost`. A call there is request/response only: its call table says "a struct `payload`, never a stream". The org plugin's Objectives page (issue #180) must show changes the host entry makes on its own, such as a task the dispatcher starts. The renderer entry cannot poll cheaply or learn of those changes from a response. How does a host entry push a sequence of values to its renderer entry, and how does that interact with a plugin closing (ADR-0055)?

## Decision Drivers

* A plugin declares one call in a module both entries import, with schemas shared by both (ADR-0057).
* A page that stays open must not delay a plugin's reload or unload. Closing a plugin waits up to `SERVICE_USE_TIME_LIMIT` (30 seconds) for each lease taken with `registry.use`.
* A subscription must end with a typed error when the host entry closes, and the renderer entry must be able to subscribe again after a reload.
* `DiaRpcs` already carries a stream (`SubscribeEvents`), with the preload resubscribing after a lost connection (ADR-0022).
* An effect a subscription runs must not run against a resource that the plugin's setup scope has already closed, such as the plugin's database.

## Considered Options

* A streaming call: `Rpc.make(tag, { ..., stream: true })`, served with `ctx.serve`, followed with `followHost`, carried by a second generic RPC `SubscribePlugin`.
* Plugin events: a typed event the host entry publishes and the renderer entry listens for.
* Polling `callHost` on a timer.

## Decision Outcome

Chosen option: "a streaming call", because it reuses the call declaration, the registry's withdrawal and the generic-RPC shape of ADR-0057, and gives a subscription the current state first. The design is `docs/designs/org-objectives-page.md`.

| Rule | Value |
| --- | --- |
| Declaring | `Rpc.make(tag, { payload, success, error, stream: true })` in a module both entries import. This replaces ADR-0057's "never a stream" |
| Serving | `ctx.serve(rpc, handler)` with a handler returning `Stream<Success, Error>` serves a streaming `rpc`. The handler runs once per subscription |
| Following | `followHost(ctx, rpc, payload)` from `@dia/renderer-plugin` returns `Stream<Option<Success>, Error \| PluginCallInvalid>`: `Some` for each value, `None` while the host entry is not serving. After `None` it subscribes again at the plugin's next status change, or after 5 seconds |
| Wire | `DiaRpcs` gains the stream `SubscribePlugin { plugin, tag, payload }` with the error `PluginCallError`. `window.dia.plugins.subscribe(plugin, tag, payload, onValue, onEnd)` carries it, and the preload subscribes again after a lost connection with no limit |
| Lease | A subscription holds no `registry.use` lease while it runs. `use` is held only while the stream value is built |
| Ending | When the scope that serves the call closes, its finalizer completes a `closed` signal. Each subscription of that tag is interrupted and ends with `PluginNotServing`; a subscription that starts after `closed` fails with `PluginNotServing` and does not run the handler. The finalizer waits for the running subscriptions to end, up to `SERVICE_USE_TIME_LIMIT`, then logs a warning and returns |
| Handler resources | A stream handler uses only resources of the scope that serves it or of an enclosing scope. It never reads a service held in a `whenProvided` or `inject` scope, which closes first |

### Consequences

* Good, because a renderer page follows host state with no polling, and reloads of the plugin reach it as `None` and then new values.
* Good, because an open page never delays a reload by 30 seconds.
* Good, because the serve finalizer runs before resources acquired earlier in setup close, so no subscription runs against a closed database.
* Bad, because the handler runs again for each resubscription, so each run must start from current state.
* Bad, because a stream handler has a resource rule the compiler does not check.
* Bad, because `PluginStatusChanged` carries only the plugin name and is not replayed, so `followHost` also waits on a 5-second timer.
* Bad, because the plugin API changes (`serve` gains an overload, `followHost` is added), so `PLUGIN_API_VERSION` goes from 0.0.31 to 0.0.32, and `DiaRpcs` gains `SubscribePlugin`, so `PROTOCOL_VERSION` goes from 0.0.25 to 0.0.26.

## Pros and Cons of the Options

### A streaming call

* Good, because it reuses the call declaration and both entries' shared schemas.
* Good, because the stream carries typed values and a typed error.
* Bad, because it adds a second generic RPC and a lifetime rule distinct from request/response calls.

### Plugin events

* Good, because it matches the existing `IpcEvent` push.
* Bad, because an event is typed in the kernel, not by the plugin, and every plugin event would need a kernel schema.

### Polling `callHost`

* Good, because it needs no kernel change.
* Bad, because it delays each change by the poll interval and reads state when nothing changed.

## More Information

* Amends ADR-0057. ADR-0055's leases are unchanged; a subscription takes none.
* `RpcSchema.getStreamSchemas` is marked internal and absent from the published types, so the host and the renderer read the stream's value and error schemas from `RpcSchema.isStreamSchema(rpc.successSchema)`.
