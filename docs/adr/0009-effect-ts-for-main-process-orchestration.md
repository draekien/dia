---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Use Effect TS for main-process orchestration logic

## Context and Problem Statement

The MVP's main process (see ADR-0007, ADR-0008) must supervise up to 6 independent per-pane `utilityProcess`es, route IPC messages per pane, manage a pane-attention state machine (idle / awaiting-permission / error / completed), and read/write persisted layout and session state — all concurrently, with failures in one pane required to stay isolated from the rest. What should this orchestration logic be built on?

## Decision Drivers

* Failures (a crashed `utilityProcess`, a bad persistence read, a denied permission) must be handled as typed, recoverable outcomes rather than uncaught exceptions, since one pane's failure must not affect others.
* The domain is inherently concurrent (N independent per-pane fibers of work) and needs structured lifecycles — a pane's process, IPC subscription, and state must all be spawned and torn down together.
* Testability of timing- and concurrency-sensitive logic (state transitions, retries) matters given the MVP's "automated + manual" testing approach.

## Considered Options

* Effect TS (`effect` + `@effect/platform-node`)
* Plain async/await with hand-rolled typed-error conventions (e.g. `neverthrow` for results, manual `AbortController` per pane)

## Decision Outcome

Chosen option: "Effect TS", because it provides structured concurrency (`Fiber`, `Scope`) that maps directly onto "one isolated unit of work per pane, spawned and torn down together," typed errors as first-class values instead of thrown exceptions, and built-in test tooling (`TestClock`/`TestServices`) for deterministic testing of the state machine and retry behavior — all of which the orchestration layer needs and would otherwise have to be assembled from smaller, less integrated libraries.

### Consequences

* Good, because per-pane process lifecycles, IPC routing, and state transitions can be expressed as scoped, typed effects rather than ad hoc `Promise`/`EventEmitter` wiring.
* Good, because domain errors (process spawn failure, persistence failure, agent session error) are typed and handled explicitly at the point they're consumed, rather than escaping as uncaught exceptions.
* Bad, because it introduces a learning curve and a distinct coding style (`Effect.gen`, `Layer`, `Schema`) that the rest of the stack (React renderer) does not use, so the codebase has two different programming models split across the process boundary.

## Pros and Cons of the Options

### Effect TS

* Good, because `Fiber`/`Scope` give per-pane concurrency and cleanup a direct primitive, rather than manual `Promise` bookkeeping per pane.
* Good, because `Schema` covers both the IPC message contract and the persisted JSON shape (ADR-0008) with one validation/encoding mechanism.
* Bad, because it's a significant dependency with its own idioms, adding ramp-up cost for a single-developer project.

### Plain async/await + hand-rolled conventions

* Good, because it stays inside idioms already used elsewhere in the codebase, with no new library to learn.
* Bad, because structured concurrency, typed errors, and scoped resource cleanup across 6 independent per-pane processes would need to be hand-built and kept consistent by convention alone, which is exactly the kind of orchestration bug surface this decision is meant to avoid.

## More Information

Scope of this decision is the main-process orchestration layer only (pane/session/process/persistence logic running in main and coordinating the per-pane `utilityProcess`es). The renderer remains plain React (ADR-0002); it consumes the IPC contract but does not itself use Effect TS.
