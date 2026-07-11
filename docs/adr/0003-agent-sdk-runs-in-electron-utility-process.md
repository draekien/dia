---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Run the Claude Agent SDK in an Electron utilityProcess

## Context and Problem Statement

The Claude Agent SDK is a Node.js library that spawns the Claude Code binary as a child process and communicates with it over JSON-RPC via stdio. Where in dia's Electron process tree should this SDK run, given it must not block the UI and should not be exposed directly to the renderer?

## Decision Drivers

* Avoid blocking the main process, which owns menus, window management, and app-level IPC.
* Keep Node.js integration out of the renderer process for security (context isolation).
* Avoid the added operational complexity of a standalone local service unless clearly justified.

## Considered Options

* Electron `utilityProcess` spawned by main, brokering IPC to the renderer
* Standalone local Node service (HTTP/WebSocket) outside Electron's process tree

## Decision Outcome

Chosen option: "Electron `utilityProcess` spawned by main, brokering IPC to the renderer", because it is Electron's purpose-built mechanism for isolating long-running background work from the main process, requires no extra service infrastructure, and keeps the Agent SDK's own child-process management self-contained within the app's lifecycle. The renderer talks to main over IPC; main brokers to the utilityProcess, which hosts the Agent SDK and its spawned Claude Code binary.

### Consequences

* Good, because the main process stays responsive — the Agent SDK's blocking/long-running work happens in an isolated process.
* Good, because there's no separate service to install, configure, or keep alive outside the app.
* Bad, because if a future requirement needs multiple app windows sharing one agent session, or headless/remote access to the agent, this model will need to be revisited in favor of a standalone service.

## Pros and Cons of the Options

### Electron utilityProcess

* Good, because it's Electron's documented, purpose-built pattern for isolated background work.
* Good, because it keeps agent lifecycle tied to the app's lifecycle — no orphaned services.
* Bad, because it's scoped to a single running instance of the app, limiting future multi-window/remote scenarios.

### Standalone local Node service

* Good, because it would support multiple windows or future remote/headless access to the same agent session.
* Bad, because it adds infrastructure (process supervision, port/socket management, versioning) not currently needed.

## More Information

If dia later needs multi-window shared sessions or remote access, revisit this decision in favor of a standalone local service.
