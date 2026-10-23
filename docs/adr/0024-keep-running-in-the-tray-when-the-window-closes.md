---
status: "accepted"
date: 2026-10-23
decision-makers: William Pei
---

# Keep dia and its agents running in the system tray when the window closes

## Context and Problem Statement

`src/main/index.ts` quits the app on `window-all-closed` on Windows and Linux, so closing the window ends every agent's turn. dia's product (`PRODUCT.md`) is now agents that run in the background and notify the user when they need input. When the user closes the window, do agents keep running?

## Decision Drivers

* Agents must keep working when the user is not looking at them.
* The user must be able to stop every agent deliberately.
* After Phase 1 of `docs/plans/2026-10-22-plugin-platform.md`, agents run in the Host process (ADR-0021), not in the window's renderer.
* ADR-0022 names "work with no window open" as a trigger for reconsidering a durable event store.

## Considered Options

* Closing the window hides it; dia keeps running in the system tray
* Closing the window quits dia (today's behaviour)
* Agents run in a service that keeps running after dia quits

## Decision Outcome

Chosen option: "Closing the window hides it; dia keeps running in the system tray", because agents keep running when the window closes with no new process and no durable event store.

| User action | Result |
| --- | --- |
| Closes the window | The window is hidden. Electron main, the Host and every agent keep running. A tray icon (Electron `Tray`) stays visible |
| Clicks the tray icon | The window is shown again |
| Chooses Quit in the tray menu | dia quits. Every agent's turn ends; each agent resumes from its SDK session on the next start (ADR-0011) |
| An agent in a hidden window needs input or fails | An OS notification (Electron `Notification`) is shown; clicking it shows the window on that agent's tab (`docs/prds/agent-os.md`) |

The tray icon shows the most urgent agent status, using the status colours in `DESIGN.md`.

The renderer still reconnects to the Host when the window is shown again, using the replay and reload rules in ADR-0022. A durable event store is not needed for this decision: the Host keeps running while the window is hidden, so its in-memory event buffer holds the events. ADR-0022's trigger for an event store is a Host that runs with no Electron app, which is the roadmap option below.

### Consequences

* Good, because closing the window no longer ends agents' work.
* Good, because quitting stays one deliberate action.
* Good, because notifications do not depend on the renderer: the Host owns agent status, and main raises the notification.
* Bad, because a user who expects close to quit leaves agents running and using their Claude usage. How dia tells the user this is an open question in `docs/prds/agent-os.md`.

## Pros and Cons of the Options

### Closing the window hides it; dia keeps running in the system tray

* Good, because no new process and no event store.
* Bad, because there is a running app with no visible window.

### Closing the window quits dia (today's behaviour)

* Good, because close means stop.
* Bad, because background agents stop whenever the window closes.

### Agents run in a service that keeps running after dia quits

* Good, because agents survive quitting dia and app updates.
* Bad, because the Host must run without Electron, and ADR-0022's durable event store becomes necessary. It is on the roadmap in `docs/prds/agent-os.md`.

## More Information

* Related: ADR-0021 (Host process), ADR-0022 (transport and its event store trigger), ADR-0023 (tabs).
* `Tray` and `Notification` are classes in Electron 43.1.0 (`node_modules/electron/electron.d.ts`).
