---
status: "accepted"
date: 2026-11-08
decision-makers: William Pei
---

# Hired agents' sessions run headless inside the org plugin

## Context and Problem Statement

The org scheduler (#179) starts a session for each task it picks. A session is opened through `AgentBackend.openSession`. Which process component opens and owns it: the org plugin, or the host's pane and tab machinery that ad-hoc chats use?

## Decision Drivers

* The overall cap counts only org work, and ad-hoc tabs are never counted (ADR-0033).
* The scheduler must see turn end, permission waits and `BackgroundTasksChanged` for each task, so it can free and take slots.
* Showing a hired agent's session as a tab is planned for #182, not #179.

## Considered Options

* The org plugin calls `AgentBackend.openSession` itself and consumes the session's events.
* The org plugin asks the host to open a tab for each task.

## Decision Outcome

Chosen option: "The org plugin calls `AgentBackend.openSession` itself", because the plugin then owns every event that decides a slot. No tab is created, so no tab count can include org work.

### Consequences

* Good, because the slot rules live in one place, `plugins/org/dispatcher.ts`, and are testable with a fake `AgentBackend`.
* Good, because the org plugin needs only `AgentBackendKey` from `ctx.whenProvided`, and no new kernel contract.
* Bad, because a permission request from a hired agent is not shown in any pane. The org plugin holds it, and `AnswerPermission` answers it, until #182 shows these sessions.
* Bad, because unloading the backend plugin closes every running task's session. At the next load, running tasks are requeued and resume their saved session id.

## Pros and Cons of the Options

### The org plugin calls `AgentBackend.openSession` itself

* Good, because the session's `OutboundMessage` events reach the dispatcher directly.
* Bad, because the transcript is not visible until #182 adds a view.

### The org plugin asks the host to open a tab for each task

* Good, because the user sees the session at once.
* Bad, because tabs are the unit ad-hoc chats use, and keeping org tabs out of the counts would need a tab kind the kernel does not have.
* Bad, because the org plugin would need a new kernel contract to read the tab's turn and permission state.

## More Information

Design: `docs/designs/org-objectives-scheduler.md`. Start mode: ADR-0054. Storage: ADR-0042 and ADR-0034.
