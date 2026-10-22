---
status: "accepted"
date: 2026-10-22
decision-makers: William Pei
---

# Connect the renderer to the Host over an authenticated localhost WebSocket

## Context and Problem Statement

Today the renderer calls `window.dia` (`src/preload/index.ts`), which uses Electron IPC to main, and main relays to each pane's `utilityProcess` (`src/main/ipc/gateway.ts`). Under ADR-0021 the agent sessions and non-UI plugins move into one Host process, and Electron main keeps only window duties. How does the renderer exchange messages with the Host?

## Decision Drivers

* Main should not relay every message, because main's code changes only on a core update.
* A client other than the Electron renderer (a browser tab, a phone) should be able to connect later without another transport change.
* Follow deepseek-harness, whose desktop renderer talks to its Host over authenticated local HTTP/WebSocket (`apps/desktop/README.md` in `deepseek-ai/deepseek-harness`).

## Considered Options

* Authenticated localhost HTTP/WebSocket served by the Host
* `MessageChannelMain` port pair handed out by main

## Decision Outcome

Chosen option: "Authenticated localhost HTTP/WebSocket served by the Host", because it keeps main out of the message path and allows clients other than the Electron renderer.

| Rule | Detail |
| --- | --- |
| Listener | The Host binds `127.0.0.1` only, on a port chosen at start |
| Authentication | The Host generates a token at start. Main passes the port and token to the renderer; every connection presents the token |
| Messages | The schemas in `src/shared/ipc/contract.ts` stay the message contract, decoded non-throwing at the boundary (`docs/reasoning/2026-07-12-decode-ipc-boundary-non-throwing.md`) |
| Plugin messages | A plugin's `host` and `renderer` entries exchange messages over the same connection, namespaced by plugin name |

### Consequences

* Good, because main never sees session or plugin traffic.
* Good, because a browser or phone client is a new client of the same server. Such a client is not in scope; `docs/prds/mvp.md` lists cross-device use as out of scope.
* Bad, because the Host exposes a listening local port, so token generation, transfer and checking are security-relevant code.
* Bad, because `window.dia` is reimplemented as a WebSocket client.

## Pros and Cons of the Options

### Authenticated localhost HTTP/WebSocket

* Good, because any client that holds the token can connect.
* Bad, because it adds a listening port and token handling.

### `MessageChannelMain` port pair

* Good, because nothing listens on a network port.
* Good, because `window.dia` keeps its shape. <!-- unverified: port transfer between a renderer and a utilityProcess was not tested -->
* Bad, because only the Electron renderer can connect.

## More Information

* Related: ADR-0021 (Host process).
