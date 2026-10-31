# Missing session recovery

Scope: module (the `AgentSession.ended` contract, the claude-code adapter's session, `PaneSupervisor`, `PaneWorkspace`). Issue #48.

When a pane resumes a session whose transcript no longer exists, the adapter reports a typed `SessionNotFound` end, and the Host clears the tab's session so the tab's next message starts a new one.

## Interface

`src/host/session/agent-backend.ts` (adds value imports of `Schema` and `SessionId`)

```ts
/** The session ended for a reason other than a missing conversation; `reason` describes it for the user. */
export const SessionFailed = Schema.TaggedStruct('SessionFailed', { reason: Schema.String })
/** The session ended because the conversation it was asked to resume, `sessionId`, no longer exists. */
export const SessionNotFound = Schema.TaggedStruct('SessionNotFound', { sessionId: SessionId })
/** Why an agent session ended on its own; match on `_tag`. */
export const SessionEnd = Schema.Union([SessionFailed, SessionNotFound])
export type SessionEnd = typeof SessionEnd.Type

export interface AgentSession {
  // unchanged members …
  /**
   * Completes with why the session ended on its own: `SessionNotFound` when the conversation it
   * resumes does not exist, `SessionFailed` for any other end. Does not complete because of a
   * restart or rewind the session performs itself; it completes if the conversation that restart
   * or rewind resumes does not exist. Does not complete when its scope is closed.
   */
  readonly ended: Effect.Effect<SessionEnd>
}
```

`src/host/plugin-api.ts` re-exports `SessionFailed`, `SessionNotFound` and `type SessionEnd` next to `SessionDeleteError`. The claude-code adapter imports them from `@dia/plugin` (a shipped plugin cannot import `src/`; `plugin-modules.test.ts` already covers the resolve hook).

`src/host/services/pane-supervisor.ts`

```ts
readonly openPane: (
  request: PaneCreationRequest,
  onEvent: (event: IpcEvent) => Effect.Effect<void>,
  onSessionChanged: (sessionId: Option.Option<SessionId>) => Effect.Effect<void>,   // was onSessionId(sessionId)
  onPermissionModeChanged: (mode: PermissionMode) => Effect.Effect<void>
) => …

// PaneHandle
/** Moves the pane to `Errored` with `error`; refused with a logged warning when the pane's attention cannot move to `Errored` (a parked pane, or one already `Errored`). */
readonly markErrored: (error: PaneError) => Effect.Effect<void>   // applyAttention(Errored.make({ error }))
```

`handleSessionEvent` calls `onSessionChanged(Option.some(id))` for `SessionStarted` and `ConversationReset`, where it calls `onSessionId(id)` today.

The `openPane` JSDoc changes from "`onSessionId` is invoked when … When the pane's session later ends on its own, the pane is marked `Crashed`" to: "`onSessionChanged` receives `Some(id)` when the session starts or the conversation resets, and `None` when the session ended because its conversation does not exist; the pane is then marked `Errored`. Any other end on its own marks it `Crashed`."

`src/shared/domain/workspace.ts` (adds an `Option` import)

```ts
/** Stores the agent session a tab resumes from, or removes it when `sessionId` is none. */
export const recordSession = (
  workspace: Workspace,
  paneId: PaneId,
  sessionId: Option.Option<SessionId>
): Result.Result<Workspace, TabNotFoundError>
```

`PaneWorkspace.recordSessionId(paneId, Option<SessionId>)`: for a tab not added yet, `some` stores the id in `pendingSessions` as today, and `none` deletes the `pendingSessions` entry; `none` is never stored in the map.

## Behaviour

| Session ends with | Supervisor does, in order | Tab afterwards | Renderer shows |
| --- | --- | --- | --- |
| `SessionNotFound({ sessionId })` | `logWarning('Pane session not found; cleared the tab session', { paneId, sessionId })`; `onSessionChanged(none)`; offer `PaneMessageQueueChanged.make({ paneId, queued: [], held: false })` to the pane's `outbound` queue (not `onEvent`), so it reaches the renderer in order with `Errored`; `handle.markErrored({ message: <notice> })`; teardown | `sessionId` absent; `WorkspaceStore.save` sets `superseded_at` on the current `agent_sessions` row and inserts none | an empty queue, then one error turn with the notice |
| `SessionFailed({ reason })` | as today: `SessionEndedError` log with `reason`, `markCrashed('Pane session ended unexpectedly: <reason>')`, teardown | unchanged | as today |

Notice: `This tab's conversation could not be found. Send your message again to start a new conversation.`

The supervisor clears the session before it publishes `Errored` and before `teardown` removes the pane, so no later `ensureLive` reads the old id. Clearing after teardown would let an `ensureLive` in between resume the old id and fail again.

A message that reaches the dying session is not delivered: one sent through `SendMessage` while the resume is in progress, or in the instant between `onSessionChanged(none)` and `teardown` removing the entry. The session drops it (`session.ts`, "Dropped a dispatch; the session has ended"), as it does for a crash today. The supervisor offers the empty queue itself, before `Errored`, through `outbound`. The adapter also emits one when its session ends (`sessionEnded` in `message-queue.ts`), but that races with the supervisor's `markErrored` and `teardown`, and `Errored`, unlike `Crashed`, does not clear the renderer's queue (`pane-chat.ts`). Queued items left in the renderer would never send. The notice asks the user to send again.

A pane whose attention cannot move to `Errored` when its session ends with `SessionNotFound` (parked, or already `Errored`) gets no notice: `markErrored` logs the refusal, and the pane is cleared and torn down.

After `SessionNotFound`:
- `resumePane` (selecting the tab, a restart) skips the tab: it has no `sessionId` and `startFresh` is `false`.
- `ensureLive` (the next `SendMessage`) opens a new pane, which starts `Idle`, through `startPaneSession(…, true)` with `resume: undefined`, using the tab's stored `config` (model, thinking level, permission mode, worktree `Reattach`). The name is untouched.

### Adapter detection (`plugins/claude-code/session.ts`)

```ts
const isSessionNotFound = (message: SDKMessage) =>
  message.type === 'result' &&
  message.subtype === 'error_during_execution' &&
  message.num_turns === 0 &&
  message.errors.some((error) => error.startsWith('No conversation found with session ID'))
```

- `startQuery` creates `notFoundRef: Ref<boolean>` and passes it to `runSession`.
- In `runSession`, for each SDK message after `reportStartupFailure` and before the reducer: when `resume` is `Some` and `isSessionNotFound(message)`, it sets `notFoundRef`, logs `Effect.logInfo('Resume target not found', { paneId, sessionId })`, and does not pass the message to the reducer, so no `TurnErrored` reaches the user.
- `runSession` still returns `Option<string>`, and its post-processor is unchanged. `startQuery`, where it completes `endedDeferred` today, chooses the end: if `notFoundRef` is set, `resume` is `Some` and `branchAt` is `undefined`, `SessionNotFound.make({ sessionId: resume.value })`; otherwise `SessionFailed.make({ reason: Option.getOrElse(failure, () => 'Agent session ended unexpectedly') })`. This covers both exits: the stream failing (observed in #48 against SDK 0.3.311: `Error: Claude Code returned an error result: No conversation found…`) and the stream completing.
- `unstartedSession` and `unavailableSession` end with `SessionFailed.make({ reason })`.
- `SessionNotFound` is reported for the first resume and a thinking-level restart. `num_turns === 0` limits the match to a result that ran no turn. A rewind (`branchAt` set) always ends as `SessionFailed`: its `resume` names a conversation that exists, and the SDK's text for a missing `resumeSessionAt` anchor is unverified, so a match there must not clear the tab's session.

The SDK gives no error code for this case: the text is matched only in the adapter. The Host never reads error text.

`PLUGIN_API_VERSION` in `src/shared/plugin/manifest.ts` moves from `'0.0.6'` to `'0.0.7'`, and the `api` of every `plugins/*/plugin.json` (agent-overview, chat, claude-code, example, layout, worktrees) moves to `0.0.7`.

## Key Data Structures

- `SessionEnd` — above. Host and adapter only; never crosses IPC, so `PROTOCOL_VERSION` is unchanged.
- `Tab.sessionId?: SessionId` — unchanged schema. A tab whose `sessionId` is removed has no current row in `agent_sessions` (`workspace-store.ts`, `writeSessions`).

## Design Rationale

**Typed end, not a new event.** The session already ends; the end needs a cause the Host can branch on. Putting the cause on `ended` keeps one place where the end is decided. A separate `OutboundMessage` would arrive alongside an `ended` that still reads as a crash, and the supervisor would need to correlate the two.

**The adapter matches the text; the Host matches the tag.** Only the adapter knows the SDK's wording (Information Hiding). Another adapter reports `SessionNotFound` its own way.

**`startQuery` decides the end.** It already completes `endedDeferred`; it owns `notFoundRef` and builds `SessionFailed` in one place, and `runSession`'s failure rendering stays as it is.

**The Host clears the session; it does not start a new one itself.** The existing `ensureLive` path already starts a fresh session with the tab's config, and the user chose an automatic fresh start on the next message. Starting a session at once would spend a `claude` process on a tab the user may not use.

**`onSessionChanged(Option)` instead of a fourth callback.** The callback reports the session the pane resumes from; none is one value of it (Strategic Programming). `recordSession` stays the single place that writes `Tab.sessionId`.

**`Errored`, not `Crashed`.** `Crashed` is terminal and reads as a failure of dia; `Errored` is the recoverable state the renderer shows as an error turn. `Errored` leaves the renderer's queue in place, so the supervisor empties it itself before `Errored`. A pane starts `Idle`, and `Idle -> Errored` is allowed (`attention.ts`).

**Plugin API `0.0.7`.** `AgentSession.ended` is part of the plugin context; `manifest.ts` requires a patch bump on every change while below 0.1.0.

## Rejected Alternatives

**The adapter restarts the query itself without `resume`.** Keeps the pane live, but the failed query may already have taken a prompt from the shared prompt queue (`docs/reasoning/2026-10-25-closed-sdk-query-takes-prompts.md`), and the message queue state machine sees a turn end first. The Host path already exists and is tested.

**Match the text in the Host.** Rejected in #48: the Host must not depend on one adapter's wording.

**A "Start a new session" button.** Rejected by the user in Understand: needs a new RPC, a `PROTOCOL_VERSION` bump and new UI.

**Replay the message that triggered the resume.** The adapter drops it inside the dying session; carrying it to the next session would need the Host to hold message text it does not hold today. The notice asks the user to resend.

## Tests

- `session-queue.test.ts` test-only changes: the fake `query` gains `fail(error)` (an error entry its `next` rethrows), and the `open` helper takes a `resume` parameter.
- adapter: a resumed session whose first result is `error_during_execution`, `num_turns: 0`, `errors: ['No conversation found with session ID: S']`, then a thrown error → `ended` is `SessionNotFound({ sessionId: S })`, and no `TurnErrored` was emitted.
- adapter: the same result followed by the stream completing → `SessionNotFound`.
- adapter: the same result without `resume` → `SessionFailed`, and `TurnErrored` is emitted.
- adapter: the same text with `num_turns: 1` → not matched; `TurnErrored` emitted.
- adapter: any other thrown error → `SessionFailed` with the rendered reason.
- adapter: a session opened with `resume: S` whose first query succeeds, then `setThinkingLevel` and a send, and the restarted query's first result is the not-found result → `ended` is `SessionNotFound({ sessionId: S })`; the first query's end did not complete `ended`.
- adapter: a rewind (`branchAt` set) whose query returns the not-found result → `SessionFailed`.
- supervisor: `ended` = `SessionNotFound` → `onSessionChanged(none)` once, an empty `PaneMessageQueueChanged`, then attention `Errored` with the notice, pane removed; `SessionFailed` → `Crashed`, `onSessionChanged` never called with none; a parked pane ending with `SessionNotFound` → `onSessionChanged(none)`, no `Errored`, pane removed.
- workspace (`pane-workspace.test.ts` harness): after the supervisor reports `onSessionChanged(none)`, the tab has no `sessionId`, a later `resumePane` opens no pane, and `ensureLive` opens one with `resume` undefined and the tab's config. The `agent_sessions` side is the existing `workspace-store.test.ts` case "leaves no current session when the tab session is cleared".
- `workspace.test.ts`: `recordSession` with `Option.none()` removes `sessionId`.
- Update existing fakes and call sites: `pane-supervisor.test.ts` fake session `ended` (`Deferred<string>` → `Deferred<SessionEnd>`) and the "routes a SessionStarted event … onSessionId" test; `agent-backend.test.ts` (`session.ended` read as a string); `pane-workspace.test.ts` `openPane` wrappers and its `onSessionId` use; the `PaneHandle` fakes in `rpc-handlers.test.ts` and `pane-workspace.test.ts` gain `markErrored: () => Effect.void`; `workspace.test.ts` `recordSession` calls; `session-queue.test.ts` `ended` assertions for an unstarted session.

## Refinement Record

**Round 1**

Applied
- *Correctness / project rule (plugins cannot import `src/`)*, blocker — the adapter could not construct `SessionEnd`; `plugin-api.ts` now re-exports the constructors.
- *Correctness*, blocker — `notFoundRef` had no place to live and a clean stream completion fell to the generic crash; `startQuery` now owns the ref and the end covers both exits.
- *Project rule (schema `.make`, JSDoc on exports)* — `Data.TaggedEnum` replaced with `Schema.TaggedStruct` members and a `Schema.Union`, each with JSDoc.
- *Correctness (ordering)* — the order clear → `Errored` → teardown and the message-drop window are now stated.
- *Correctness (message loss on send)* — the notice now asks the user to send again; replay listed as rejected.
- *Project rule (`pendingSessions`)* — `none` deletes the pending entry.
- *Correctness (detection too broad)* — the predicate requires `num_turns === 0`; restart and rewind paths are stated as covered.
- *Tests omitted* — existing tests that change are listed.
- *Logging* — adapter and supervisor log lines named.
- *PLUGIN_API_VERSION* — `manifest.ts` and all six manifests named; `docs/` holds `0.0.6` only in ADR-0042 and `host-database.md`, which describe that past bump.

Rejected
- *POLA (naming)*, the split into `clearSession` plus `onSessionCleared` — rejected: two callbacks for one value add a parameter for every caller; the JSDoc of `recordSession` and `onSessionChanged` now says none removes the session.
- "Matches only before `SessionStarted`" — not applied: whether the SDK emits `init` before the not-found result is unverified, and `num_turns === 0` already limits the match.

**Round 2**

Applied
- *Correctness*, major — the supervisor had no way to set `Errored`; `PaneHandle.markErrored` added, with the parked-pane case stated and tested.
- *Correctness (renderer queue)*, major — `Errored` does not empty the renderer's queue; the supervisor now offers an empty `PaneMessageQueueChanged` first. The Rationale's queue claim and "`Errored -> Idle` on the next send" (the next send opens a new pane) were corrected.
- *Project rule (JSDoc, tests)*, major — the `openPane` JSDoc rewrite, `agent-backend.test.ts`, and the two `onSessionId` call sites are now named.
- *Minimize Complexity* — `runSession` keeps returning `Option<string>`; `startQuery` chooses the end.
- *Naming / JSDoc accuracy* — `SessionFailed` JSDoc covers sessions that never started; the `ended` JSDoc on restarts reworded.
- *Tests vs claims* — a thinking-level restart test added; the rewind text marked unverified.
- *Imports and wording* — `Schema`, `SessionId` and `Option` imports noted; detection runs after `reportStartupFailure`.

**Round 3**

Applied
- *Tests listed*, major — the `PaneHandle` fakes in `rpc-handlers.test.ts` and `pane-workspace.test.ts` (both typed `PaneHandle`) and the `onSessionId` use in `pane-workspace.test.ts` are named.
- *Tests vs fake*, major — the fake `query` cannot throw and `open` hardcodes `resume: none`; both test-only extensions are named.
- *Ordering wording* — the empty queue goes through `outbound`; the adapter's own empty queue races with teardown, which is why the supervisor sends one.
- *`markErrored` refusal* — also refused for an already `Errored` pane; stated.
- *Data safety (rewind)* — a rewind ends as `SessionFailed`, so a match cannot clear a conversation that exists; a test added.
- *Source of the thrown error* — cited as observed in #48 against SDK 0.3.311.

Not applied
- `Idle -> Errored` phrasing — the critic confirmed `Completed` and `AwaitingPermission` also allow `-> Errored`; no change needed.

Checked: `docs/designs/claude-code-adapter.md` stays accurate. Its unavailable session still ends with `The claude-code adapter is not loaded`, now as `SessionFailed`, and the pane is still marked `Crashed`.
