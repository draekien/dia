# Cross-plugin renderer calls

Issue: draekien/dia#240, step 2 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0074. Amends the `callHost` row of ADR-0057.

Lets a plugin's `renderer` entry call and follow the calls another plugin's `host` entry serves, and lets a request/response handler tell a resent call from a first call.

## Success criteria

1. Plugin A's renderer calls `callHost('dia-b', rpc, payload)` with an `rpc` that plugin B's exported module declares and B's host entry serves, and receives B's typed result; B's typed error reaches A as the same error. (Test: `src/renderer/src/lib/plugin-messages.test.ts`.)
2. Plugin A's renderer follows a streaming call B's host entry serves with `followHost('dia-b', rpc, payload)` and receives B's values. (Same test file.)
3. A handler receives `{ id, resent }` as its second argument. The first attempt of a call has `resent: false`; every attempt the preload sends after a failed attempt has the same `id` and `resent: true`. (Tests: `src/preload/host-api.test.ts` for the wire, `src/host/plugins/plugin-messages.test.ts` for the handler.)
4. The plugin's own `payload` reaches the handler unchanged when it has fields named `id`, `resent` or `call`. (Host test.)

## Interface

### Renderer (`@dia/renderer-plugin`)

```ts
/** The plugin whose host entry serves a call: its name, or a plugin context (the caller's own plugin). */
export type PluginTarget = string | Pick<PluginServices, 'name'>

callHost(target: PluginTarget, rpc, payload)   // unchanged otherwise
followHost(target: PluginTarget, rpc, payload) // unchanged otherwise
```

`callHost(ctx, ...)` keeps calling the caller's own host entry, so every existing call site is unchanged. A plugin that serves calls to other plugins declares them with `Rpc.make` in a file listed in its `plugin.json` `exports` (ADR-0057 module exports, `docs/designs/plugin-module-exports.md`); a caller imports them as `@dia-plugin/<name>/<file>`.

### Host (`ctx.serve`)

```ts
// src/shared/plugin/messages.ts
/** What the Host tells a request/response handler about the call it is running. */
export const PluginCallAttempt = Schema.Struct({
  /** Identifies one `callHost` call; every resend of that call has the same `id`. */
  id: Schema.NonEmptyString,
  /** True when an earlier attempt of this call was sent; the Host may or may not have run it. */
  resent: Schema.Boolean
})
export type PluginCallAttempt = typeof PluginCallAttempt.Type

// HostPluginContext.serve, request/response overload
handler: (payload: Rpc.Payload<R>, call: PluginCallAttempt) => Effect<Rpc.Success<R>, Rpc.Error<R>>
```

A streaming handler's signature is unchanged.

### Wire

`CallPlugin` payload: `{ plugin, tag, payload, call: PluginCallAttempt }`. The plugin's payload stays nested under `payload`, so its field names never collide with the wrapper's. `PROTOCOL_VERSION` 0.0.28 → 0.0.29; `PLUGIN_API_VERSION` 0.0.37 → 0.0.38 and every shipped `plugin.json` follows.

`window.dia.plugins.call(plugin, tag, payload)` keeps its signature. The preload mints `id` with `newRequestId` once per `call`, and sends `resent: false` on the first attempt and `resent: true` on each retry inside `RESEND_WINDOW`.

## Decisions

### D1. Deduplication rule for a resent call (taken without the user)

The kernel does not deduplicate plugin calls. It passes `{ id, resent }` to the handler; a handler whose effect must apply once records `id` with its effect and, when it sees an `id` it has recorded, returns the recorded result without applying anything. `dia-runs` records it as the `requestId` in the run's events (ADR-0074). A handler that is safe to repeat ignores the argument.

`resent: true` means "an earlier attempt was sent", not "an earlier attempt ran": the preload cannot know whether a failed attempt reached the Host. A handler must not skip work on `resent` alone; it is a hint for logging and for skipping the lookup of `id` when `false`.

Alternatives:

* Kernel deduplication by `(plugin, id)` in memory, returning the first result (`CommandDeduper` style). Rejected: it is lost on a Host restart and a plugin reload, attempts overlap (ADR-0057: the first is not cancelled), and `dia-runs` must deduplicate durably in its own events anyway, so it would deduplicate twice.
* The caller puts a `requestId` in each plugin's payload. Rejected: every plugin repeats the field and the preload cannot keep it stable across resends without knowing the payload shape.
* The Host computes `resent` from ids it has seen. Rejected: it needs per-call state in the kernel for a flag the preload already knows.

### D2. Do ADR-0068 streaming calls cover `dia-run-events`' event streams? (taken without the user)

Yes, with no API change. ADR-0068 runs a stream handler once per subscription and again on each resubscription with the same payload, and requires each run to start from current state. `dia-run-events` therefore serves a run's stream as a snapshot first, then each new event carrying its sequence number; a subscriber replaces its state on each snapshot and applies events after it. The payload carries no cursor, so a resubscription after a lost connection or a reload never replays from a stale cursor. `followHost('dia-run-events', ...)` reaches it from any renderer plugin.

Alternatives:

* A cursor in the payload, advanced on each resubscription. Rejected for now: `followHost` and the preload encode the payload once, so this needs a payload-per-attempt API; add it in step 3 only if snapshot size makes resending a snapshot too slow.
* A kernel event bus for plugin events. Rejected for the reason ADR-0068 rejected plugin events: the kernel would need a schema per plugin event.

### D3. How a caller names the target plugin (taken without the user)

The first argument of `callHost` and `followHost` accepts a plugin name. Alternatives: a binding object the exporter builds (`pluginCalls('dia-b', { ... })`) — rejected as a second declaration form for one string; keeping `{ name: 'dia-b' }` only — rejected because it reads as a fake context.

## Logging

`callHost` and `followHost` already log the plugin and tag at debug level. `callPlugin` logs `{ plugin, tag, id, resent }` at debug level when it runs a handler.

## Refinement record

Round 1 (inline):

* minor, Strategic Programming — "`resent` ... a hint": a flag a handler must not act on is weak. Rejected: the issue's done criterion requires the resend to be visible to the handler, and the doc states the one safe use.
* minor, Information Hiding — exposing `id` to handlers leaks the preload's retry. Rejected: the id is the concept ADR-0074 needs (`requestId`), not an implementation detail of the retry.
* No blocker or major finding; rounds stopped after round 1.
