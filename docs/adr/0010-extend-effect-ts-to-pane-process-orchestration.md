---
status: "accepted"
date: 2026-07-12
decision-makers: William Pei
---

# Extend Effect TS to pane-process orchestration

## Context and Problem Statement

ADR-0009 scoped Effect TS to the main-process orchestration layer only, leaving `agent-session.ts` (the code running inside each pane's `utilityProcess`) as plain TypeScript — reasoned at the time as low-value, since a single per-pane loop had little concurrency to structure and process-level failure isolation (ADR-0007) already covered the main risk. Extending the Agent SDK session to full streaming mode (`includePartialMessages`) and interactive tool permission (`canUseTool`) changes that: the session must now bridge two independent concurrent channels — inbound text/permission-resolution messages and outbound partial-message/tool-call/permission-request events — and hold a tool call suspended pending a decision that arrives asynchronously over IPC, arbitrarily later, potentially after the process has been idle. Should `agent-session.ts` keep using plain `async`/`EventEmitter`/hand-rolled queue patterns, or adopt Effect TS to match the main process?

## Decision Drivers

* `canUseTool` must suspend a tool call until a decision arrives over IPC (a `ResolvePermission` message), with no bound on how long that takes — this is a wait-for-external-signal problem, not a simple callback.
* The session now has two genuinely concurrent obligations (consume inbound messages, produce outbound events) plus the suspended-permission wait, rather than one straight-through loop.
* `pane-supervisor.ts` and `gateway.ts` (main process) were already refactored to bridge Node/Electron callback APIs into Effect via `Stream.async`, with `Effect.fn` for reusable workflows — keeping `agent-session.ts` on a different idiom means the two ends of the same IPC channel are built two different ways for no remaining reason.
* Testability: the reducer that turns raw SDK stream events into outbound events, and the permission-suspension logic, both benefit from the same test patterns (`@effect/vitest`) already available to the main process.

## Considered Options

* Extend Effect TS into `agent-session.ts` (supersede ADR-0009's process-boundary scope)
* Keep `agent-session.ts` plain TypeScript and hand-roll the permission-suspension and dual-channel logic (e.g. a `Map<string, (result) => void>` of pending resolvers, manual `EventEmitter` bridging)

## Decision Outcome

Chosen option: "Extend Effect TS into `agent-session.ts`", because `Deferred` is a direct fit for the suspend-until-external-resolution shape of `canUseTool`, `Stream.async` already bridges `parentPort`'s message events on the main-process side of this exact channel, and using the same primitives on both ends removes a duplicated, hand-rolled equivalent (a manual pending-resolvers map) that would otherwise need to be built and kept correct by convention alone — precisely the kind of orchestration bug surface ADR-0009 already decided was worth Effect's dependency cost.

### Consequences

* Good, because tool-permission suspension is expressed as `Deferred.await`/`Deferred.succeed` instead of a hand-rolled `Map<string, (result) => void>` of pending resolvers.
* Good, because the inbound/outbound message bridging in `agent-session.ts` now mirrors `pane-supervisor.ts`'s `Stream.async` pattern — one idiom for both ends of the same IPC channel.
* Good, because the SDK-event-to-outbound-event mapping (partial text deltas, tool-call lifecycle) is a pure reducer over a `Stream`, independently testable without a running Agent SDK session.
* Bad, because every `utilityProcess` fork (up to 6 concurrent panes, ADR-0007) now bundles the Effect runtime, not just `Schema`; bundle size and per-pane startup cost should be spot-checked if pane count or startup latency ever becomes a concern.
* Bad, because ADR-0009's original rationale ("renderer is the one process kept simple/plain") no longer generalizes to "everything outside main is plain" — the boundary is now specifically the renderer (ADR-0002), not the process type.

## Pros and Cons of the Options

### Extend Effect TS into `agent-session.ts`

* Good, because `Deferred` models "suspend until an external, arbitrarily-delayed signal arrives" directly, which is exactly what deferred permission resolution needs.
* Good, because it eliminates a second, inconsistent bridging idiom between the two ends of the same channel.
* Bad, because it adds Effect's learning curve and runtime weight to a process that was deliberately kept simple in ADR-0009.

### Keep `agent-session.ts` plain TypeScript

* Good, because it stays lightweight and avoids duplicating Effect's runtime into every forked `utilityProcess`.
* Bad, because suspend-until-resolved permission handling and dual-channel concurrency would need to be hand-built (a manual pending-resolvers map, manual `EventEmitter` bridging) and kept consistent by convention — the same category of risk ADR-0009 already rejected for the main process.

## More Information

This supersedes ADR-0009's stated scope ("main-process orchestration layer only... renderer remains plain React... does not itself use Effect TS"). ADR-0009's decision to use Effect TS at all, and its exemption of the renderer (ADR-0002), still stand — only the process-level boundary changes: Effect TS now governs main **and** the per-pane `utilityProcess` (`agent-session.ts`); the renderer remains the sole Effect-free process.

Scope of what actually shipped alongside this ADR: `agent-session.ts` rewritten in Effect (`Stream.async` over `parentPort`, `Effect.fn` for the session workflow, `Deferred` for `canUseTool` suspension), plus the enriched `protocol.ts`/`contract.ts` schemas needed to carry partial-text, tool-call-lifecycle, and permission-request/resolution messages end-to-end. Renderer UI for tool-call status and a permission dialog is deliberately out of scope here — those events flow through and are decoded, but not yet displayed; that UI work belongs to Bullet 03 (`.draekien/break-down-prd/dia-mvp/03-attention-state-pulse.md`), which also owns the `AttentionState` state machine these permission-request events will eventually drive.
