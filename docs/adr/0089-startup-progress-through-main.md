---
status: "accepted"
date: 2026-11-20
decision-makers: William Pei
---

# Report startup progress to the renderer through main before `HostReady`, and show it as an event stream

## Context and Problem Statement

ADR-0027 shows a `Starting dia` placeholder (`StartupSkeleton`) until `HostReady`, because the renderer receives the Host's WebSocket port and token only with `HostReady` (`src/host/host-main.ts` calls `HostPlugins.start()` and then posts `Ready`). PR #189 limits each plugin's entry import and its setup to 10 s, so one stuck eager plugin can hold startup for up to 20 s while the placeholder names nothing. How does the renderer show each startup step, and the eager plugin being waited on, before it can reach the Host?

## Decision Drivers

* The renderer cannot call `plugins.list` before `HostReady`.
* An eager plugin must still load before any renderer RPC reaches the Host (ADR-0027).
* A renderer that reloads during startup must show the steps already taken.
* Plugin state colours follow DESIGN.md's One Voice Rule: Error Red marks an error.

## Considered Options

* Send the Host's port and token before eager plugins load, and read `plugins.list` over the WebSocket.
* The kernel reports its startup steps to main over `parentPort`; main records them and pushes them to the renderer over Electron IPC.

## Decision Outcome

Chosen option: "The kernel reports its startup steps to main", because it keeps the eager-before-`Ready` guarantee and needs no Host connection.

* `makePluginRegistry` takes an optional `onStartup` callback. `start` reports the eager plugin count, each eager plugin's load start and outcome, and the end of the eager loads. Lazy and manual plugins produce no startup event.
* The Host forwards each event to main as a `StartupProgress` message through `AppWindow.reportStartup`.
* main records its own steps (Host forked, `Booted`, `Init` sent, `Ready`) and the kernel's events in one log, stamped with main's clock. A new Host run empties the log. main pushes the whole log as `StartupLogChanged` on `CHANNEL.event` and serves it on `getStartupLog`.
* `StartupLogChanged` joins `IpcEvent`, which `GlobalEventFrame` in `DiaRpcs` carries, so `PROTOCOL_VERSION` becomes `0.0.35`.
* The renderer replaces `StartupSkeleton` with `StartupStream`: an append-only log of steps and one pinned line that names the step in progress and its elapsed time.
* This amends ADR-0027's first progress tier. ADR-0027's rule that plugin state uses text only, never amber, red or green, no longer applies to the startup stream: a failed plugin's `failed` verb there is Error Red. The header indicator and the plugins page keep the text-only rule.

### Consequences

* Good, because the user sees which eager plugin startup is waiting on, and for how long.
* Good, because the WebSocket handshake and the eager-before-`Ready` order are unchanged.
* Bad, because the startup log adds one Host-to-main message type and one main-to-renderer event to maintain beside `plugins.list`.
* Bad, because a renderer built for protocol `0.0.34` cannot connect to this Host.

## Pros and Cons of the Options

### Send the Host's port and token before eager plugins load

* Good, because the renderer reuses `plugins.list` and `onStatusChanged`.
* Bad, because renderer RPCs (workspace, runs) could reach the Host before eager plugins load, which breaks ADR-0027's guarantee.

### The kernel reports its startup steps to main

* Good, because main already receives every Host message during the handshake.
* Bad, because the progress reaches the renderer by a second path, separate from the plugin status events.

## More Information

Spec: `docs/designs/startup-event-stream.md`. Issue #190. Amends ADR-0027.
