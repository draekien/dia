---
status: "accepted"
date: 2026-10-23
decision-makers: William Pei
---

# Run background agents in tabs that are not on screen; closing the window still quits dia

## Context and Problem Statement

dia's product (`PRODUCT.md`) is now agents that run in the background and notify the user when they need input. `src/main/index.ts` quits the app on `window-all-closed` on Windows and Linux, which ends every agent's turn. What does "background" mean for the first iteration: an agent that is not on screen inside dia, an agent in a window hidden to the system tray, or an agent that keeps running after dia quits?

## Decision Drivers

* Agents must keep working when the user is not looking at them.
* The first iteration should not change dia's process lifetime before the plugin platform's Host exists (ADR-0021).
* ADR-0022 names "work with no window open" as a trigger for reconsidering a durable event store.

## Considered Options

* Background means a tab that is not visible; closing the window quits dia (today's behaviour)
* Closing the window hides it; dia keeps running in the system tray
* Agents run in a service that keeps running after dia quits

## Decision Outcome

Chosen option: "Background means a tab that is not visible; closing the window quits dia", because the user chose it (2026-10-23) for the first iteration, and it needs no change to dia's process lifetime.

| User action | Result |
| --- | --- |
| Selects another agent's tab | The previous agent keeps running in its tab, which is no longer visible (ADR-0023) |
| Minimises the window, or switches to another app | Every agent keeps running |
| An agent in a tab that is not visible, or in a window that is minimised or not focused, needs input or fails | An OS notification (Electron `Notification`) is shown; clicking it focuses the window on that agent's tab (`docs/prds/agent-os.md`) |
| Closes the window | dia quits, as today. Every agent's turn ends; each agent resumes from its SDK session on the next start (ADR-0011) |

### Consequences

* Good, because `window-all-closed` and the app's lifetime do not change.
* Good, because no durable event store is needed: ADR-0022's trigger is not met.
* Bad, because closing the window still ends every agent's work. Keeping agents running without a window is on the roadmap.

## Pros and Cons of the Options

### Background means a tab that is not visible; closing the window quits dia

* Good, because nothing about the process model changes.
* Bad, because the window must stay open, even if minimised, for agents to keep working.

### Closing the window hides it; dia keeps running in the system tray

* Good, because closing the window no longer ends agents' work.
* Bad, because it adds a tray icon, a tray menu and a running app with no visible window. It is on the roadmap.

### Agents run in a service that keeps running after dia quits

* Good, because agents survive quitting dia and app updates.
* Bad, because the Host must run without Electron, and ADR-0022's durable event store becomes necessary. It is on the roadmap.

## More Information

* Related: ADR-0011 (session resume), ADR-0021 (Host process), ADR-0022 (event store trigger), ADR-0023 (tabs).
* `Notification` is a class in Electron 43.1.0 (`node_modules/electron/electron.d.ts`).
