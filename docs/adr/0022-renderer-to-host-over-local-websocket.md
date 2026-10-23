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
| Authentication | The Host generates a token at start and sends the port and token to main over `parentPort`. The preload hands them to the renderer. Every connection presents the token as the WebSocket subprotocol `dia.token.<hex>` |
| Origin | The packaged renderer is served from `dia://app` through Electron's `protocol.handle`. The Host refuses an upgrade whose `Origin` is not `dia://app`, or the electron-vite dev server origin in a dev build |
| Messages | The schemas in `src/shared/ipc/contract.ts` stay the message contract, defined as an `effect/rpc` `RpcGroup` and served with `RpcServer.makeProtocolWithHttpEffectWebsocket`; `window.dia` is an `effect/rpc` client. Decoding stays non-throwing at the boundary (`docs/reasoning/2026-07-12-decode-ipc-boundary-non-throwing.md`) |
| Protocol version | Checked when the connection opens. On a mismatch the Host closes the connection with an application close code (4000–4999), because a browser reports every refused upgrade as close code 1006 |
| Reconnect | Pane events carry a per-pane sequence number; a resubscription names the last one received and gets the events after it from an in-memory buffer, or is told to reload history from the transcript. Commands carry a client-generated `commandId`, and the Host ignores one it has already accepted |
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

* Amended 2026-10-22 after comparing with T3 Code (`pingdotgg/t3code` at commit `8d3b061`), whose desktop app runs the same topology: `effect/rpc` over the WebSocket (`apps/server/src/ws.ts`), an `Origin` allowlist for a custom-scheme renderer (`apps/server/src/auth/EnvironmentAuth.ts`), protocol-version checks at the upgrade, and sequence-numbered replay on reconnect.
* T3 Code also persists every event to SQLite with a transactional outbox (`docs/internals/overview.md`, "Durable intent and side effects"), because it serves several independently versioned clients, does work with no client connected, and drives providers with no shared transcript. dia does not: the Agent SDK session store holds the history (ADR-0011). Revisit with a durable event store if dia adds a second client, work that runs with no window open, or a provider other than Claude.
* Related: ADR-0021 (Host process).
