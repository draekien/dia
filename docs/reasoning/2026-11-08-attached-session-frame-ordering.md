# Attached sessions rely on global frames reaching subscribers before later pane frames

**Date:** 2026-11-08

## Context

`AgentSummaries` (`src/host/services/agent-summaries.ts`) must know which pane ids are attached sessions (ADR-0070) before it folds their pane events, or `applyWorkspace` drops their summaries on the next `WorkspaceChanged`. The first design had `AgentSummaries` read `AttachedSessions.current` when a pane event arrived. That reads a value the hub has not delivered yet, so a summary could be dropped or kept depending on fibre scheduling.

## Reasoning / Learning

`EventHub.publish` (`src/host/services/event-hub.ts`) puts a global event straight on the PubSub as a `GlobalEventFrame`. A pane signal is first appended to `AgentEventStore`, and reaches the PubSub only when `store.committed` emits it. `AttachedSessions.attach` publishes `AttachedSessionsChanged` before it calls `PaneSupervisor.attachPane`. So every subscriber sees `AttachedSessionsChanged` before the attached session's first pane frame. `AgentSummaries` folds `AttachedSessionsChanged` from the hub as a frame, the same way it folds `WorkspaceChanged`, and needs no other dependency.

`HostPlugins` cannot depend on `AttachedSessions`: `AttachedSessions` uses `PaneSupervisor` and `PaneChatProjection`, which depend on `HostPlugins` through `TranscriptReader` and `ModelCatalogFeed`. `SessionAttacher` is a dependency-free `Deferred` that both receive; `AttachedSessionsLive` completes it, and `ctx.sessions.attach` awaits it.

## Implication

A service that needs the set of attached sessions must fold `AttachedSessionsChanged` frames from `EventHub`, not read `AttachedSessions.current`. Keep `attach` publishing the change before it starts the pane. If `EventHub.publish` ever routes global events through the store, this order no longer holds.
