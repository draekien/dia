---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Run one utilityProcess per pane for concurrent independent agent sessions

## Context and Problem Statement

dia's MVP introduces split panes where each pane is a fully independent agent session with its own conversation, working directory, and model. ADR-0003 established that the Agent SDK runs in an Electron `utilityProcess`, but did not address multiple concurrent sessions. Should each pane get its own `utilityProcess`, or should one `utilityProcess` multiplex multiple Agent SDK sessions internally?

## Decision Drivers

* Panes must behave like independent tmux panes: one pane's agent failing or hanging must not affect any other pane.
* Each pane can point at a different working directory and model, which the Agent SDK already scopes per session/process rather than per in-process call.
* Avoid building custom multiplexing/routing logic inside a single process when Electron already provides per-process isolation as a primitive.

## Considered Options

* One `utilityProcess` per pane
* One shared `utilityProcess` multiplexing multiple Agent SDK sessions

## Decision Outcome

Chosen option: "One `utilityProcess` per pane", because it gives each pane the same crash and resource isolation as a real tmux pane running its own shell, requires no in-process session router, and keeps each `utilityProcess`'s lifecycle tied 1:1 to its pane's lifecycle (spawned on pane open, torn down on pane close).

### Consequences

* Good, because a crash or hang in one pane's agent/Claude Code process cannot affect other panes.
* Good, because per-pane working directory and model fall out naturally from each `utilityProcess` owning one Agent SDK session.
* Bad, because resource usage (memory, process count) scales linearly with pane count, capping comfortable concurrency (targeted at up to 6 panes for the MVP).

## Pros and Cons of the Options

### One utilityProcess per pane

* Good, because it isolates failures per pane, matching the tmux mental model.
* Good, because main only needs to broker IPC per pane, not route within a shared session.
* Bad, because N panes means N Node runtimes plus N spawned Claude Code binaries running concurrently.

### Shared utilityProcess, multiplexed sessions

* Good, because it has a lower resource footprint than one process per pane.
* Bad, because it requires custom in-process routing to keep each session's messages, permissions, and state separated by pane.
* Bad, because a crash in the shared process takes down every pane's session at once, breaking the independence panes are meant to provide.

## More Information

Revisit if the per-pane process overhead becomes a practical limit before reaching the MVP's 6-pane target.
