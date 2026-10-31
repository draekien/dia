# Inline hold-to-rewind with reported failures

Lets the user rewind a pane to just after an agent turn by pressing and holding a button under that turn, and shows the rewind's progress and any failure in that row. Fixes #105 (a failed rewind is silent).

Scope: module (session event, IPC event, a per-pane renderer atom, two pure selectors, the chat pane's row).

## Behaviour

```
U1  "add a login page"
A1  "Done, created login.tsx"
    [↺ Rewind]       revealed on hover or focus of A1; targets U2 (checkpointUuid U2, resumeAnchorUuid A1)
    [↺ Hold]         while pressed (pointer down, or Space/Enter held); fill grows over 1 s; release before 1 s returns to Rewind, sends nothing
    [⟳ Rewinding…]   after 1 s; disabled; visible without hover; every other Rewind in the pane is disabled
    ⚠ Rewind failed: No file checkpoint found for this message.  [Dismiss]   red, visible without hover; holding Rewind again retries
U2  "now add tests"
A2  "Added login.test.tsx"     no row: no user turn after it
```

The row sits under the whole agent message, after its last part or collapsed steps section. On success the transcript truncates at U2 through the existing `PaneRewoundToCheckpoint` fold, and the row returns to idle. The `AlertDialog` and the separator marker above user turns are removed.

Behaviour removed, accepted by the user: rewinding to before the first user turn. The user's stated replacement is `/clear` (it does not restore files). Also no row for the first user turn after a compaction (see `rewindTargets`). The session keeps its unresumed-rewind branch (`session.ts` `startQuery(…, Option.none(), undefined)`); the UI no longer reaches it.

## Interface

### Session (plugins/claude-code)

`rewindToCheckpoint(messageUuid, resumeAnchorUuid)` keeps its signature `Effect<void>`. Every exit emits exactly one of `RewoundToCheckpoint { messageUuid }` (unchanged, on success) or `RewindFailed { messageUuid, cause, detail? }`:

| Exit | `cause` | `detail` |
| --- | --- | --- |
| no config, session id or query | `NoLiveSession` | — |
| `resolveRewindAnchor` fails | `TurnNotInTranscript` | — |
| `rewindFiles` resolves with `canRewind: false` | `FilesNotRewound` | the SDK's `error` text, when present |
| `rewindFiles` rejects or exceeds `REWIND_FILES_TIMEOUT` | `FilesNotRewound` | — |
| failure, defect or interruption after `rewindFiles` succeeded | `ConversationNotBranched` | — |
| any other failure, defect or interruption | `Interrupted` | — |

`rewindToCheckpoint = (messageUuid, resumeAnchorUuid) => Effect.flatMap(Ref.make<RewindOutcome>('pending'), (outcome) => rewindBody(outcome, messageUuid, resumeAnchorUuid).pipe(restartLock.withPermits(1), Effect.ensuring(reportUnfinishedRewind(outcome, messageUuid))))`, where `RewindOutcome = 'pending' | 'filesRewound' | 'emitted'` and `rewindBody` is the current `Effect.fn` body taking `outcome` first. The public signature is unchanged. Each early exit emits its `RewindFailed` and sets `'emitted'`. The success path sets `'filesRewound'` after `rewindFiles` succeeds and `'emitted'` right after `emit(RewoundToCheckpoint)`, so a later failure in `performActions` emits nothing more. The `onExit` wraps the lock, so an interruption while waiting for the permit is covered. On a non-success exit it reads `outcome`: `'pending'` emits `Interrupted`, `'filesRewound'` emits `ConversationNotBranched`, `'emitted'` does nothing. Each `RewindFailed` emission is preceded by the existing `Effect.logWarning`/`logError` line, which gains a `cause` annotation.

### Shared domain (src/shared/domain/rewind.ts)

```ts
/** Why a rewind did not complete. `ConversationNotBranched` means the files were already rewound. */
export const RewindFailureCause = Schema.Literals([
  'NoLiveSession', 'TurnNotInTranscript', 'FilesNotRewound', 'ConversationNotBranched', 'Interrupted'
])
/** A {@link RewindFailureCause} value. */
export type RewindFailureCause = typeof RewindFailureCause.Type
```

`protocol.ts`, `contract.ts` and the renderer import it from `@shared/domain/rewind`; `@shared/*` is already aliased in every config. The plugin reaches it through `protocol.ts`'s re-export in `plugin-api.ts`.

### Host protocol (src/host/session/protocol.ts)

```ts
/** Emitted by a pane's agent session when a `RewindToCheckpoint` for `messageUuid` did not complete. `cause` says how far it got; `detail`, when present, is the Agent SDK's own explanation. */
export const RewindFailed = Schema.TaggedStruct('RewindFailed', {
  messageUuid: Schema.String,
  cause: RewindFailureCause,
  detail: Schema.optional(Schema.String)
})
```

`RewindFailed` is added to `OutboundMessage`.

### IPC contract (src/shared/ipc/contract.ts)

```ts
/** Event pushed to the renderer when a {@link RewindToCheckpoint} for `messageUuid` in pane `paneId` did not complete. The transcript is unchanged; show `cause` (and `detail`) to the user. */
export const PaneRewindFailed = Schema.TaggedStruct('PaneRewindFailed', {
  paneId: Uuid,
  messageUuid: Schema.String,
  cause: RewindFailureCause,
  detail: Schema.optional(Schema.String)
})
```

Added to `IpcEvent`; `HostApi` gains `onRewindFailed(listener)` (JSDoc'd like `onRewoundToCheckpoint`). `pane-supervisor.ts` maps `RewindFailed` to it. `PROTOCOL_VERSION` goes `0.0.8` → `0.0.9`.

### Renderer (src/renderer/src/lib)

New module `src/renderer/src/lib/pane-rewind.ts` holds `RewindTarget` (moved from `pane-chat-atoms.ts`), `RewindProgress`, `RewindCommand`, `RewindRowState`, `rewindTargets`, `rewindRowState` and `rewindFailureMessage`. `pane-chat-atoms.ts` imports from it and keeps `paneRewindAtom`. `src/renderer/src/plugin-api.ts` re-exports `rewindTargets`, `rewindRowState` and the types `RewindTarget`, `RewindProgress`, `RewindCommand` and `RewindRowState`, since `plugins/chat` cannot import `src/`.

```ts
/** A pane's rewind as the renderer last saw it. Read from {@link paneRewindAtom}. */
export type RewindProgress =
  | { readonly status: 'idle' }
  | { readonly status: 'rewinding'; readonly checkpointUuid: string }
  | { readonly status: 'failed'; readonly checkpointUuid: string; readonly message: string }

/** What {@link paneRewindAtom} accepts: start a rewind to `target`, or dismiss a failure. */
export type RewindCommand =
  | { readonly type: 'start'; readonly target: RewindTarget }
  | { readonly type: 'dismiss' }

/**
 * Per-pane rewind state and action, keyed by `paneId`. Read it for the pane's {@link RewindProgress};
 * set it with a {@link RewindCommand}. Starting sends the rewind to the pane process (ADR-0018); the
 * outcome arrives as `PaneRewoundToCheckpoint` (transcript truncation, through {@link paneChatAtom})
 * or `PaneRewindFailed`. Kept alive for the renderer's lifetime so a failure that arrives while the
 * pane's tab is hidden is still shown. Bind with `useAtom(paneRewindAtom(paneId))`.
 */
export const paneRewindAtom: (paneId: string) => Atom.Writable<RewindProgress, RewindCommand>
```

Transitions:

| From | Input | To |
| --- | --- | --- |
| `idle` or `failed` | `start` | `rewinding` (calls `window.dia.rewindToCheckpoint`) |
| `rewinding` | `start` | unchanged |
| `failed` | `dismiss` | `idle` |
| `rewinding` or `failed` for X | `PaneRewindFailed` for X | `failed` with `message` = `rewindFailureMessage(cause, detail)` |
| `rewinding` or `failed` for X | `PaneRewoundToCheckpoint` for X | `idle` |
| `rewinding` | `PaneAttentionChanged` to `Crashed` or `Errored`, `onHistoryReloadRequested` for the pane | `idle` |
| `rewinding` | no outcome within `REWIND_OUTCOME_TIMEOUT = Duration.seconds(45)` (`REWIND_FILES_TIMEOUT` 30 s plus margin) | `failed` with `Rewind failed: the agent did not respond.` |

Events for other panes, or for a `messageUuid` other than the one rewinding, are ignored. `current: RewindProgress` and `timer` are declared in the `Atom.family` callback, outside `read` and `write`, so both close over them. `read` returns `idle`, captures its `AtomContext.setSelf`, and registers the listeners with `get.addFinalizer`. Every transition goes through one `transition(next)` helper that assigns `current`, calls the captured `setSelf`, logs, and clears `timer` on any exit from `rewinding`. `write` reads `current` (its `WriteContext` has no `self()`) and starts the timer on `start`; `pane.tsx` binds with `useAtom`, which mounts the atom before any write. The atom is `Atom.keepAlive`. Accepted cost: a closed pane's listeners (four per pane) stay registered until the renderer exits. Each transition logs `Effect.logDebug` with `paneId` and `checkpointUuid`, using the `Effect.runSync(Effect.logDebug(…))` pattern from `actions.ts`.

```ts
/** The sentence shown for a failed rewind, e.g. `Rewind failed: No file checkpoint found for this message.` */
export const rewindFailureMessage: (cause: RewindFailureCause, detail?: string) => string
```

| `cause` | Message |
| --- | --- |
| `NoLiveSession` | `Rewind failed: the session is not running.` |
| `TurnNotInTranscript` | `Rewind failed: this turn is no longer in the session transcript.` |
| `FilesNotRewound` | `Rewind failed: ` + `detail`, or `the files could not be restored.` |
| `ConversationNotBranched` | `Rewind failed: files were restored, but the conversation could not be branched.` |
| `Interrupted` | `Rewind failed: the rewind was interrupted.` |

```ts
/** For each agent turn the user may rewind to, the rewind target that keeps that turn and discards everything after it. Keyed by the agent message's `id`. Pass the pane's `PaneChatState.messages`. */
export const rewindTargets: (messages: ReadonlyArray<PaneMessage>) => ReadonlyMap<string, RewindTarget>
```

Rule: for each user turn U with `checkpointUuid` and `rewindable !== false`, scan backwards from U. Skip `error` messages and notices without `compaction`. The first `assistant` message found maps to `{ checkpointUuid: U.checkpointUuid, resumeAnchorUuid: U.resumeAnchorUuid }`. The scan stops with no entry at a user turn, at a compaction notice, or at the start of the transcript.

```ts
/** What one agent turn's rewind row shows, given the pane's {@link RewindProgress} and that row's target. */
export type RewindRowState =
  | { readonly status: 'ready' }
  | { readonly status: 'blocked' }
  | { readonly status: 'rewinding' }
  | { readonly status: 'failed'; readonly message: string }
export const rewindRowState: (progress: RewindProgress, target: RewindTarget) => RewindRowState
```

`rewinding`/`failed` when `progress.checkpointUuid === target.checkpointUuid`; `blocked` while another row is `rewinding`; otherwise `ready`.

### Chat pane (plugins/chat)

`MessageView`'s `onRewind?: (message) => void` is replaced by `rewind?: { state: RewindRowState; onStart(): void; onDismiss(): void }`, passed only for agent turns `rewindTargets` maps. `MessageView` renders a `RewindAction` row under the agent message.

`RewindAction` owns the hold:

- Pointer down, or `keydown` Space/Enter with `repeat` false (`preventDefault()`; `onClick` does nothing), starts a timer of `HOLD_DURATION = Duration.seconds(1)` and shows `Hold`.
- Pointer up, leave or cancel, `keyup`, blur, or unmount before the timer ends clears it and returns to `Rewind`.
- When the timer fires: `onStart()`.
- The fill's `animation-duration` is `Duration.toMillis(HOLD_DURATION)` set inline. Under `prefers-reduced-motion` the fill is not animated; the timer still runs.
- Class names come from a `cva` with a `state` variant (`ready | holding | rewinding | failed | blocked`), following `components/status-indicator.tsx`. `failed` uses `text-destructive`, as the error `Marker` in `pane.tsx` does.
- `Rewinding…` has `role="status"`; the failure has `role="alert"` and a `Dismiss` button calling `onDismiss()`.
- The button's accessible name is `Rewind to here, press and hold`.
- In states `rewinding` and `failed`, and while holding, the row is visible without hover.

## Tests and docs touched

- `plugins/claude-code/session-rewind.test.ts`: the timeout test and the anchorless-turn test also assert `RewindFailed` (`FilesNotRewound`, `TurnNotInTranscript`). New cases: no live session (`NoLiveSession`), `canRewind: false` with `detail`, interruption while waiting for the lock (`Interrupted`), failure after `rewindFiles` succeeded (`ConversationNotBranched`), and no `RewindFailed` after `RewoundToCheckpoint`.
- `src/host/services/pane-supervisor.test.ts`: `RewindFailed` maps to `PaneRewindFailed`, with `detail` passed through or omitted.
- `src/renderer/src/lib/pane-rewind.test.ts`: `rewindTargets` (stops at a compaction notice, skips `rewindable: false` and `error`, no entry for the first turn, batch), `rewindRowState`, `rewindFailureMessage`.
- `paneRewindAtom` tests with fake timers: every row of the transition table.
- `plugins/chat/pane.test.tsx`: `RewindAction`: release before 1 s sends nothing; a 1 s pointer hold and a 1 s Space/Enter hold call `onStart` once; `keyup` cancels; `failed` shows the message with `role="alert"` and Dismiss.
- `pane.tsx`: rewrite the `MessageView` JSDoc; remove the `AlertDialog*` imports, the `rewindTarget` state, and imports nothing else uses.
- `docs/designs/message-queue-and-steer.md:158-159`: reword its rewind-control and `paneRewindAtom` references.
- A new ADR superseding ADR-0018's sentence on the user-turn anchor and confirmation dialog (pending the user's decision).

## Design Rationale

**Failure travels as an event, not an RPC error** — `RewindToCheckpoint` is a fire-and-forget command with resend and dedupe by `commandId`; success already returns as `RewoundToCheckpoint`. Reporting failure the same way keeps one path for the rewind outcome and does not turn a resent command into a second rewind.

**The session reports a cause, the renderer writes the sentence** — the session knows how far the rewind got; wording is presentation. A literal union makes an unknown cause unrepresentable; the SDK's text passes through only as `detail`.

**`Effect.ensuring` plus a renderer timeout** — `Effect.ensuring` covers every exit of the session effect, including defects that `withHandle` in `rpc-handlers.ts` only logs. The timeout covers what never reaches the session (`ensureLive` failure, unknown pane, preload resends exhausted).

**Progress lives in a kept-alive per-pane atom, not `PaneChatState` or React state** — only the visible tab is rendered, so React state is lost on a tab switch, and an idle-TTL atom is disposed after 30 s hidden, which would drop a late failure. `PaneChatState` is folded only from Host events and cannot take a local `dismiss`, and `rewinding` must show when the hold completes, before any Host event. The atom owns the rewind's lifecycle; the row sees only `RewindRowState` (Information Hiding).

**`rewindTargets` and `rewindRowState` are pure functions** — which agent turn carries which checkpoint is a fact about the transcript, and what a row shows is a fact about one progress value and one target. Both are tested without rendering, and the row never compares uuids.

**The hold lives in `RewindAction`** — pointer and key timing are presentation; the atom receives only `start`.

## Rejected Alternatives

**Keep the dialog and show the error in it** — rejected by the user in favour of an inline control.

**A `RewindStarted` session event** — the renderer sets `rewinding` itself when it sends the command; an event adds a protocol message and shows progress late (after `restartLock`).

**Rewind control above the user turn** — rejected by the user; the row under the agent turn reads as "go back to here".

**Free-text `reason` from the session** — rejected: puts UI copy in the adapter and admits any string.

## Refinement Record

**Round 1**

Applied
- *Correctness (B1)* — not every exit emitted an outcome; added `onExit` in the session and `REWIND_OUTCOME_TIMEOUT` in the atom.
- *Correctness (B2)* — atom now resets on `onHistoryReloadRequested`.
- *Correctness (B3)* — idle TTL disposes the atom after 30 s hidden; now `Atom.keepAlive`.
- *Correctness (B4)* — `rewindTargets` stops at a compaction notice.
- *Information Hiding / Law of Demeter (M1)* — added `rewindRowState`; the row no longer sees uuids.
- *Project rules: JSDoc (M3)* — JSDoc specified for every new or changed export, including the rewritten `paneRewindAtom` doc.
- *Project rules: logging (M4)* — session annotates its existing logs with `cause`; atom logs transitions using the `actions.ts` pattern.
- *Project rules: cva (M5)* — `RewindAction` styles through a `cva` `state` variant.
- *Information Hiding (M6)* — session emits `cause` + `detail`; the renderer writes the sentence.
- *Correctness (M7)* — the removed first-turn rewind is stated in Behaviour. ADR conflict escalated below.
- *Minor m1–m4* — unmount clears the timer; keyboard details stated; `start` from `failed` documented in the transition table; fill duration from `HOLD_DURATION`.

Rejected
- *Project rules: schema-derived types (M2)* — `RewindProgress`, `RewindCommand` and `RewindRowState` are renderer-local, never decoded, and have no schema; the rule forbids a hand type *parallel to* a schema. `PaneMessage` and `PaneChatState` in the same layer are plain interfaces.

**Round 2**

Applied
- *Correctness (1, blocker)* — `WriteContext` has no `self()` or `addFinalizer` (`Atom.ts:216-221`); state and timer now live in a closure shared by `read` and `write`, with `setSelf` captured from `read`.
- *Correctness (2)* — `onExit` mechanism specified: per-call `outcome` `Ref`, placed after `restartLock.withPermits(1)`.
- *Project rules: shared schemas (3)* — `RewindFailureCause` moved to `src/shared/domain/rewind.ts`; `contract.ts` cannot import `src/host`.
- *Correctness (4)* — a late `PaneRewoundToCheckpoint` after the timeout now clears `failed`.
- *Correctness (5)* — `Errored` also resets `rewinding`.

**Round 3**

Applied
- *Correctness / project rules (1)* — `plugins/chat` reaches renderer values only through `plugin-api.ts`; added module `pane-rewind.ts` and its re-exports.
- *Project rules: tests and docs (2)* — added "Tests and docs touched".
- *Correctness (3)* — a trailing `Effect.fn` combinator cannot see a `Ref` made in the body; committed to the wrapper form.
- *Simplicity (4)* — closure variables declared in the `Atom.family` callback, where `read` and `write` both see them.
- *Resource (5)* — kept-alive listeners per closed pane stated as an accepted cost.

Rejected
- *Strategic Programming (6)* — merge `ready` and `blocked`: kept both; the `cva` `state` variant names `blocked`, and the reviewer did not press it.

Escalated
- *ADR-0018* — line 31 says rewind is "anchored to user turns" and "gated behind a confirmation dialog". This design moves the control under the agent turn and replaces the dialog with a 1 s hold. The checkpoint itself is still anchored to the user turn. Needs the user's decision at the gate: a new ADR superseding that sentence.
