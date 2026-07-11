---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Use Electron as the desktop application shell

## Context and Problem Statement

dia needs a cross-platform desktop shell that can host a rich chat UI and drive a local Node-based agent process (the Claude Agent SDK). Which desktop application framework should the shell be built on?

## Decision Drivers

* Must run a Node.js process to host the TypeScript Agent SDK without a separate runtime bridge.
* Should match the architecture of Anthropic's own Claude Desktop app where reasonable, since it's a proven fit for this exact problem (agent SDK + chat UI + MCP child processes).
* Ecosystem maturity: examples, libraries, and community solutions for chat-style desktop apps.

## Considered Options

* Electron
* Tauri

## Decision Outcome

Chosen option: "Electron", because it runs a full Node.js environment in its main process, which is a direct fit for hosting the Claude Agent SDK (itself a Node/TypeScript library that spawns child processes over stdio). Anthropic's own Claude Desktop app is built on Electron using the same three-process model (Main, Preload, Renderer), so this choice follows a proven architecture for this exact class of app.

### Consequences

* Good, because Node.js is a first-class citizen in the main process — no need for a Rust/Node bridge (as Tauri would require) to run the Agent SDK.
* Good, because the ecosystem (IPC patterns, packaging, auto-update) is mature and well documented.
* Bad, because Electron apps have a larger baseline memory/disk footprint than Tauri apps.

## Pros and Cons of the Options

### Electron

* Good, because it natively hosts Node.js in the main process, matching the Agent SDK's runtime.
* Good, because it mirrors Claude Desktop's own proven architecture.
* Bad, because bundle size and memory usage are higher than Tauri.

### Tauri

* Good, because it produces much smaller binaries and uses less memory (Rust backend, native OS webview).
* Bad, because running a Node-based Agent SDK would require a separate sidecar process and a custom IPC bridge, adding complexity for no clear benefit here.
* Bad, because Windows' WebView2 dependency introduces its own platform quirks.

## More Information

See also [ADR-0003](0003-agent-sdk-runs-in-electron-utility-process.md) for how the Agent SDK is hosted within this Electron shell.
