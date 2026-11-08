# Attached sessions: hired agents' sessions shown as rows in the agent overview

Scope: layer. Lets a host plugin attach a session it opened to the Host's pane machinery, so the session is recorded, shown in its project's group in the agent overview, and driven by the chat plugin's transcript and composer like a tab (issue #182, plan step 8 of `docs/plans/2026-10-28-org.md`). The org dispatcher attaches every hired agent's session it opens.

Governing decisions: ADR-0033, ADR-0050, ADR-0051, ADR-0052, ADR-0067 (amended by the new ADR-0070 below). Visual rules: `DESIGN.md` (Agent Overview), updated by this change with `/impeccable`.

## Success criteria

Confirmed with the user before design.

1. While a hired agent's issue has a live session, a row named after the hire, with its job title, appears in that project's group. The row disappears after `release` or when the session ends. *(test + app)*
2. Selecting the row shows the live transcript, which grows as the agent works. *(app)*
3. A `queue` message from the composer reaches `session.sendText(text, 'queue')`; a `steer` message reaches `session.sendText(text, 'steer')`, interrupts the turn and runs next. *(test + app; PRD goal 11)*
4. Answering a permission card in the hired pane clears the dispatcher's pending entry and resumes the agent through `answerPermission`, reaching the SDK session's `resolvePermission` exactly once. *(test)*
5. Attached sessions never enter `Workspace`: `tabIdsOf(workspace)` and the persisted workspace exclude them, and a project group's count counts its tabs and attached sessions. *(test)*
6. `docs/prds/org.md` has no open question on placement. *(diff)*

## Settled product decisions

| Decision | Value |
|---|---|
| Placement | A row in the issue's project group, labelled with the hire's name (option B, chosen by the user) |
| Transport | A Host attach API; the session stays owned by the plugin that opened it |
| Hidden for attached rows | Model, thinking level and permission mode pickers; rewind; Rename, Archive, Delete |
| Lifetime | The row exists while the attachment's scope is open; the dispatcher closes that scope on `release` and on session end |
| Question and plan-review answers | Go straight to the session; the agent resumes at once and can take a slot over the cap. Already accepted in `docs/designs/org-objectives-scheduler.md` ("A session can take a slot on its own…") |
| Permission answers | Go through `Dispatcher.answerPermission`; the agent resumes ahead of `todo` issues when a slot frees (ADR-0033) |

## Out of scope and known limits

- **OS notifications.** `plugins/notifications/notification-rule.ts` titles an agent from workspace tabs only, so attached sessions raise no OS notification. A follow-up issue is raised.
- **`Finished` status.** `AgentSummaries` clears `Finished` when the workspace's `visibleTab` shows the pane; an attached pane is never the `visibleTab`, so its row stays `Finished` after a completed turn until the row is released.
- **Status after a permission answer.** The pane leaves `AwaitingPermission` when the answer is queued, so the row reads `Working` while the agent waits for a slot.

## Interface

### Shared domain — `src/shared/domain/attached-session.ts`

Display data the renderer reads. It holds no session.

```ts
/** A session a host plugin attached to the Host, as the renderer shows it (ADR-0070). */
export const AttachedSession = Schema.Struct({
  config: PaneConfig,              // config.paneId identifies it wherever a tab's paneId does
  projectId: ProjectId,            // the project group it is shown in
  label: Schema.NonEmptyString,    // the row's name, e.g. "Ada"
  caption: Schema.String           // shown beside the label, e.g. "Software engineer"
})
export type AttachedSession = typeof AttachedSession.Type
```

### Host plugin context — `src/host/plugins/host-plugin-context.ts`

`AgentSession` and `OutboundMessage` live in `src/host/session`, so the field cannot be declared in `src/shared/plugin/api.ts` (ADR-0013). The Host widens the shared context; `src/host/plugin-api.ts` exports this `HostPluginContext` explicitly, which shadows the shared one its `export *` brings in, so plugins keep importing `HostPluginContext` from `@dia/plugin`. `host-plugins.ts` and `plugin-loader.ts` use it. `host-plugin-context.ts` imports the shared one as `import type { HostPluginContext as SharedHostPluginContext } from '@shared/plugin/api'`. `src/host/plugin-api.ts` adds `export { AttachedSession } from '../shared/domain/attached-session'` and `export type { HostPluginContext, HostSessions, SessionAttachment } from './plugins/host-plugin-context'`, because a shipped plugin reaches host values only through `@dia/plugin`.

```ts
/** The request a plugin passes to `ctx.sessions.attach`: the session's display data and how to open it. */
export interface SessionAttachment {
  readonly display: AttachedSession
  readonly resume: Option.Option<SessionId>
  /** Opens the session. Report every event to `emit`. */
  readonly open: (
    emit: (message: OutboundMessage) => Effect.Effect<void>
  ) => Effect.Effect<AgentSession, never, Scope.Scope>
}

/** Sessions a plugin attaches to the Host. */
export interface HostSessions {
  /**
   * Opens the session through `open`, records its events, shows it as a row in project
   * `display.projectId`'s group, and routes the composer's commands for `display.config.paneId`
   * to the session `open` returns. Closing the calling scope closes the session and removes the
   * row. Rewind is refused for an attached session. To change how a command reaches the agent,
   * return a wrapped `AgentSession` from `open`.
   */
  readonly attach: (attachment: SessionAttachment) => Effect.Effect<void, never, Scope.Scope>
}

/** The context a plugin's `host` entry receives: the shared context plus `sessions`. */
export interface HostPluginContext extends SharedHostPluginContext {
  readonly sessions: HostSessions
}
```

### Host — `PaneSupervisor.attachPane` (`src/host/services/pane-supervisor.ts`)

```ts
/**
 * Starts `attachment`'s session in a scope of its own that closes when the calling scope closes, as an attached pane: its events are recorded
 * and published through `onEvent`, and `getHandle(display.config.paneId)` returns its handle until
 * the scope closes. The session's end is the owner's to handle; the pane is removed only when the
 * scope closes.
 */
readonly attachPane: (
  attachment: SessionAttachment,
  onEvent: (event: IpcEvent) => Effect.Effect<void>
) => Effect.Effect<void, never, Scope.Scope>
```

It makes a closeable scope with `Scope.make()` and runs the private `startPane` in it, with a one-use factory `{ start: ({ emit }) => attachment.open(emit) }`, no-op `onSessionChanged` and `onPermissionModeChanged`, and `attachment.resume`. It forks `drain(onEvent)` with `Effect.forkDetach` as the entry's `subscriber`, makes the `closed` deferred, and stores the entry in `entriesRef` with a handle whose `rewindToCheckpoint` logs `Refused rewind for an attached session` and does nothing. It adds `teardown(paneId)` as a finalizer of the calling scope; `teardown` ends `outbound`, joins `subscriber` and closes the entry's scope, which closes the session. It forks no `session.ended` watcher. `startPane` has no typed failure; a defect in it closes the entry scope and reaches the caller of `attach`, so the dispatcher's `Deferred.await(raw)` is never reached on that path. `closeAll` at shutdown tears attached entries down too; the owner's later finalizer finds no entry and returns.

Because the entry is in `entriesRef`, `getHandle`, `rpc-handlers.ts` `withHandle` and `withLiveHandle` (`ensureLive` returns early when a handle exists), and `closeAll` handle it with no change.

### Host — `AttachedSessions` (`src/host/services/attached-sessions.ts`)

```ts
/** The sessions plugins have attached. Provide with `AttachedSessionsLive`. */
export class AttachedSessions extends Context.Service<AttachedSessions, {
  /** Attaches a session (see `HostSessions.attach`). */
  readonly attach: HostSessions['attach']
  /** The attached sessions now. */
  readonly current: Effect.Effect<ReadonlyArray<AttachedSession>>
  /** The attached sessions, first as they are now and then after each change. */
  readonly changes: Stream.Stream<ReadonlyArray<AttachedSession>>
}>()('AttachedSessions') {}
```

`attach` adds `display` to its list and publishes `AttachedSessionsChanged`, calls `paneChats.seed(paneId)`, then `supervisor.attachPane(attachment, hub.publish)`; a finalizer removes the list entry and publishes again. `EventHub.publish` puts a global frame on its `PubSub` at once, while a pane frame reaches it only after `store.append` commits, so every follower sees the attachment before the session's first event. 

**Cycle break.** `PaneSupervisor`, `TranscriptReader` and `ModelCatalogFeed` depend on `HostPlugins`, so `AttachedSessions` cannot be a dependency of `HostPlugins`. A dependency-free `SessionAttacher` service holds a `Deferred<HostSessions['attach']>`; `AttachedSessionsLive` completes it when built. `HostPlugins.extend` sets `sessions.attach` to an effect that awaits the deferred on each call, not at extend time; if the Host shuts down first, the waiting call is interrupted with the plugin's scope. `host-main.ts` builds one `SessionAttacher` layer constant and provides that reference to both `makeHostPluginsLive` and `AttachedSessionsLive`. `AttachedSessionsLive` requires `PaneSupervisor`, `PaneChatProjection`, `EventHub` and `SessionAttacher`; `DiaRpcHandlersLive` requires `AttachedSessions` (for `GetAttachedSessions`); `host-plugins.test.ts` provides a `SessionAttacher`.

### Host — other changes

| Place | Change |
|---|---|
| `AgentSummaries` | `State` gains `tabIds` and `attachedIds`. `handle` sets `attachedIds` from each `AttachedSessionsChanged` frame; `applyWorkspace` sets `tabIds` and keeps every summary whose id is in `tabIds ∪ attachedIds`. When an `AttachedSessionsChanged` frame removes an id that is not a tab, its summary becomes `idleSummary(paneId, previous.activity)` and `AgentSummaryChanged` is published, which clears a pending request in the renderer's map before the id can be attached again; the summary is dropped at the next `WorkspaceChanged`. `flush` writes only summaries whose id is in `tabIds`. No new layer dependency |
| `rpc.ts` | new RPC `GetAttachedSessions` → `Array(AttachedSession)`; `contract.ts` global event `AttachedSessionsChanged`; `PROTOCOL_VERSION` bumps |
| `PaneChatProjection` | `seed` keeps a non-tab entry (`inWorkspace: false`); the `seed` and `snapshot` JSDoc now say a seeded non-tab id keeps its state; new `release(paneId)` drops a non-tab entry, and `AttachedSessions` calls it when a session detaches |

### Org plugin — `plugins/org/dispatcher.ts`

`makeDispatcher` takes `attach: HostSessions['attach']`. `agentName(hire, jobTitles)` moves from `org-actions.ts` (`agent.name ?? \`Unnamed ${jobTitle}\``) to `domain.ts`, and both use it. `startIssue` replaces `backend.openSession(...)`:

```ts
const raw = yield* Deferred.make<AgentSession>()
yield* attach({
  display: AttachedSession.make({ config, projectId: objective.projectId, label: agentName(hire, [jobTitle]), caption: jobTitle.name }),
  resume: Option.fromNullishOr(issue.sessionId),
  open: (emit) =>
    backend.openSession({ ...options, emit: (m) => emit(m).pipe(Effect.andThen(onEvent(issue.id)(m))) }).pipe(
      Effect.tap((session) => Deferred.succeed(raw, session)),
      Effect.map((session) => ({
        ...session,
        resolvePermission: (requestId, response) =>
          answerPermission(issue.id, requestId, response).pipe(
            Effect.catchTag('PermissionNotPending', (error) =>
              Effect.logWarning('Ignored an answer to a permission request that is not pending', error)))
      })))
}).pipe(Scope.provide(scope))
const session = yield* Deferred.await(raw)
```

`config` and the other `openSession` options are the values `startIssue` builds today. `LiveIssue.session`, the `session.ended` watcher, `sendText(prompt)` and `resumeIssue` use the raw `session`. The existing per-issue `scope` closes on `release` and `onEnded`, which removes the row. `plugins/org/host.ts` passes `ctx.sessions.attach`. `dispatcher.test.ts` passes a fake `attach` that runs `open(emit)` in the caller's scope and records each `display`.

### Renderer

| Place | Change |
|---|---|
| `src/renderer/src/lib/view.ts` | `AttachedView { paneId }`; `OpenAttached { paneId, shownBefore }` like `OpenPage`. `viewOf(workspace, form, page, attached, attachedSessions)`: page, form, attached while its id is in `attachedSessions`, else the visible tab |
| `actions.ts` | `selectAttached(paneId)` sets `openAttachedAtom` to `{ paneId, shownBefore }` (from `tabHiddenByPage()`, extended to read an open attached view), clears page and form, and calls `window.dia.selectTab(null)`. `selectTab` clears it. `openPage` and `newAgent` take `shownBefore` from it, as from an open page, and clear it |
| `workspace-atoms.ts` | `attachedSessionsAtom` follows `getAttachedSessions` and `AttachedSessionsChanged`. `closesOpenAttached(attached, workspace)` is true when `visibleTab` is not null and not `attached.shownBefore`; `loadedWorkspaceAtom` applies it on every `WorkspaceChanged`, as for the page. When the open id leaves the attached list, the atom is set to `None` and `window.dia.selectTab(shownBefore)` runs if `shownBefore` is not null |
| `src/preload/host-api.ts`, `window.dia` type | `getAttachedSessions()` and `onAttachedSessionsChanged(listener)`; `refreshWorkspace` also fetches the list after a reconnect and dispatches `AttachedSessionsChanged` |
| `@dia/renderer-plugin` | exports `useAttachedSessions()` and `actions.selectAttached` |
| `plugins/agent-overview/overview.ts` | `OverviewRow.name` widens to `string` (a tab's `AgentName` or an attachment's `label`) and the row gains `caption: string | null` (the job title of an attached session, `null` for a tab); `buildOverview` takes the attached list and adds rows to the group with the same `projectId`; sort unchanged; `total` counts tabs and attached rows |
| `agent-row.tsx` | an attached row shows its caption after the name, its menu has Show only, `F2` does nothing, and selecting calls `selectAttached` |
| `plugins/chat/chat.tsx` | for `AttachedView`, renders `Pane` from the attached session's `config` with `fixedSettings` |
| `plugins/chat/pane.tsx` | `fixedSettings?: boolean`: hides the model, thinking and permission pickers and the rewind rows |
| `tab-header.tsx` | for `AttachedView`, the header reads `<project displayName> / <label>` from the project with `projectId` and the `AttachedSession` |
| `tab-content.tsx` | renders `AttachedView` as it renders `TabView` |

## Design Rationale

**Attach, not open.** The plugin keeps opening the session with its job title's options (ADR-0067); the Host wraps `emit` and keeps a handle. The dispatcher's slot rules are unchanged.

**Attach inside `PaneSupervisor`.** Recording, attention, parking, the message queue and `PaneHandle` are what a tab already has, and `startPane` already takes a session factory. Putting `attachPane` beside `openPane` keeps `startPane` private (Information Hiding) and gives one handle map, so command routing needs no change.

**Override by wrapping the session.** The Host calls `session.resolvePermission`; the dispatcher routes answers through `answerPermission`. A wrapped session hides that from the Host and adds no flag to `attach` (Strategic Programming). The dispatcher keeps the raw session for its own calls, so a queued answer reaches the SDK once.

**The owner handles the session's end.** The dispatcher already watches `session.ended` and closes the scope; a second watcher in the Host would race it and write into a queue being closed.

**A list beside the workspace.** Attached sessions never enter `Workspace`, so the workspace store never saves them and tab counts and ADR-0033's ad-hoc counting stay correct.

**`fixedSettings` names what is fixed, not who the caller is.** `Pane` does not know about hired agents.

## New ADR — `docs/adr/0070-plugins-attach-sessions-to-the-host.md`

Plugins attach a session they open to the Host, which records it and shows it as a row in its project's group. Amends ADR-0067: a hired agent's permission request is shown in its pane. ADR-0067's status becomes `accepted, amended by ADR-0070`, and 0070 is added to `docs/adr/README.md`.

## Refinement Record

**Round 1**

Applied
- *Correctness* (blocker 1) — `SessionAttachment` named host types in `src/shared/plugin/api.ts`; now declared in `src/host/plugins/host-plugin-context.ts`, with `HostPluginContext` widened host-side and exported from `@dia/plugin`.
- *Correctness* (blocker 2) — `attach` returned the wrapped session, so `resumeIssue` called `answerPermission` again; `attach` now returns `void` and the dispatcher keeps the raw session through a `Deferred`.
- *Correctness* (3) — `AgentSummaries.applyWorkspace` dropped attached summaries on each `WorkspaceChanged`; it now keeps `tabIds ∪ attachedIds`.
- *Correctness* (4) — attached rows stay `Finished`; recorded as a known limit.
- *Correctness* (5) — notifications skip attached panes; recorded as out of scope.
- *Information Hiding* (6) — exporting `startPane` exposed supervisor internals; attach is now `PaneSupervisor.attachPane`, and `startPane` stays private.
- *Correctness* (7) — Host and dispatcher both watched `session.ended`; the Host no longer does.
- *Minimize Complexity* (8) — the `ensureLive` skip and the second handle lookup are gone: the entry lives in `entriesRef`.
- *Define Errors Out of Existence* (9) — rewind was guarded only by a hidden control; the attached handle refuses it.
- *Correctness* (10) — status reads `Working` after a queued answer; recorded as a known limit.
- *Correctness* (11) — question and plan-review answers: settled row added, citing the scheduler design.
- *Minor* (13, 14) — the header source, view fallback and member JSDoc are spelled out; `list` became `current` and `changes`; `controls` became `fixedSettings`.

Rejected
- *Correctness* (12) — free projection entries on release: each entry is one issue's chat state, bounded by the issues run in one process lifetime, and a resumed issue reuses it.

**Round 2**

Applied
- *Correctness* (blocker 1) — `attachPane` did not build a `PaneEntry` (`scope`, `subscriber`, `closed`); it now makes its own closeable scope, forks the drain as `subscriber`, and registers `teardown` on the calling scope.
- *Correctness* (2) — the attached view had no reset: added `closesOpenAttached` on `WorkspaceChanged`, the `shownBefore` hand-off with pages and the form, and the restore when the id leaves the list.
- *Correctness* (3) — `AgentSummariesReplaced` is preload-only; removal now publishes nothing.
- *Project rules* (4) — `@dia/plugin` exports `AttachedSession`, `HostSessions`, `SessionAttachment` and the widened `HostPluginContext`.
- *Correctness* (5) — the preload, `window.dia` and `attachedSessionsAtom` row added, with reconnect refresh.
- *Correctness* (6) — layer wiring stated.
- *Correctness* (7) — the `attachedIds` stream raced pane events; `AgentSummaries` reads `attached.current` on each `WorkspaceChanged`, and `attach` adds the list entry before the session opens. `flush` writes tabs only.
- *Minor* (8) — title, ADR index and status, projection JSDoc, `OverviewRow.name` type, and the dispatcher test fake.

**Round 3**

Applied
- *Minimize Complexity* (1) — `AgentSummaries` read `attached.current` through a new dependency and `flush` had no tab set; it now folds `AttachedSessionsChanged` frames into `attachedIds`, keeps `tabIds` in `State`, and takes no new dependency. Ordering verified in `event-hub.ts`: global frames are published to the `PubSub` directly, pane frames after `store.append`.
- *Correctness* (2) — a re-attached `paneId` could show a stale permission card from the renderer's unpruned summary map; removal now publishes an idle summary.
- *Correctness* (3) — the `startPane` failure sentence contradicted `attach`'s `never` error; reworded to the defect path.
