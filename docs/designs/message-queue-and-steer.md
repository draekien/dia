# Message queue and steer

Status: accepted, implemented.

The claude-code adapter session decides, for each user message sent while a turn runs, whether it waits in a per-pane queue (`queue`) or interrupts the turn and runs next (`steer`). It owns the queue's contents and reports them to the renderer, which shows and edits them.

Scope: `plugins/claude-code/session.ts` and a new `plugins/claude-code/message-queue.ts`, the kernel `AgentSession` and `PaneHandle` interfaces, the `DiaRpcs` protocol, the settings store, and the renderer composer, pane chat state and command palette. `PROTOCOL_VERSION` is not bumped (user decision, overriding the root `CLAUDE.md` rule). A renderer built before this change sends `SendMessage` without `mode`, and the Host rejects it at decode.

## Interface

### Domain schemas (`src/shared/domain/message-queue.ts`)

```ts
export const SendMode = Schema.Literals(['queue', 'steer'])
export type SendMode = typeof SendMode.Type

export const OutgoingMessage = Schema.Struct({ id: Schema.String, text: Schema.String })
export type OutgoingMessage = typeof OutgoingMessage.Type

export const MessageQueueSnapshot = Schema.Struct({
  queued: Schema.Array(OutgoingMessage),
  held: Schema.Boolean
})
export type MessageQueueSnapshot = typeof MessageQueueSnapshot.Type
```

`held` is true when the queue waits for the next user send instead of the next turn end. `held` is false whenever `queued` is empty.

`agent-backend.ts`, `settings-store.ts`, `protocol.ts` and `contract.ts` import these from `@shared/domain/message-queue`, as they import `ThemePreference` from `@shared/domain/theme`. The plugin imports them as types only.

### Commands (`src/shared/ipc/contract.ts`, `src/shared/ipc/rpc.ts`)

| Command | Payload → success | RPC wrapper | Handler lookup |
| --- | --- | --- | --- |
| `SendMessage` | `{ paneId, text, mode: SendMode }` | `withRequestId` | `withLiveHandle` (unchanged) |
| `EditQueuedMessage` | `{ paneId, messageId, text }` | `withRequestId` | `withHandle` |
| `RemoveQueuedMessage` | `{ paneId, messageId }` | `withRequestId` | `withHandle` |
| `GetMessageQueue` | `{ paneId }` → `MessageQueueSnapshot` | none, as `GetPaneHistory` | `withHandle`; empty snapshot when the pane has no live session |
| `GetSendMode` | → `SendMode` | none, as `GetTheme` | settings store |
| `SetSendMode` | `{ mode: SendMode }` | none, as `SetTheme` | settings store |

No payload field is named `commandId`, the field `withRequestId` adds. `rpc-handlers.test.ts` checks that `mode`, `messageId` and `text` reach the handler unchanged.

### Events (`IpcEvent`)

| Event | Payload | Meaning |
| --- | --- | --- |
| `PaneMessageQueueChanged` | `{ paneId, ...MessageQueueSnapshot }` | the full queue after a change, in send order |
| `PaneUserMessagesSent` | `{ paneId, messages: ReadonlyArray<OutgoingMessage> }` | these messages were given to the SDK as one turn, in order |

### Window API (`window.dia`)

```ts
sendMessage(paneId: string, text: string, mode: SendMode): void
editQueuedMessage(paneId: string, messageId: string, text: string): void
removeQueuedMessage(paneId: string, messageId: string): void
getMessageQueue(paneId: string): Promise<MessageQueueSnapshot>
getSendMode(): Promise<SendMode>
setSendMode(mode: SendMode): Promise<void>
onMessageQueueChanged(listener): () => void
onUserMessagesSent(listener): () => void
```

### Kernel (`src/host/session/agent-backend.ts`, `src/host/services/pane-supervisor.ts`)

```ts
interface AgentSession {
  readonly sendText: (text: string, mode: SendMode) => Effect.Effect<void>
  readonly editQueuedText: (messageId: string, text: string) => Effect.Effect<void>
  readonly removeQueuedText: (messageId: string) => Effect.Effect<void>
  readonly messageQueue: Effect.Effect<MessageQueueSnapshot>
  // existing members unchanged
}

interface PaneHandle {
  readonly sendMessage: (text: string, mode: SendMode) => Effect.Effect<void>
  readonly editQueuedMessage: (messageId: string, text: string) => Effect.Effect<void>
  readonly removeQueuedMessage: (messageId: string) => Effect.Effect<void>
  readonly messageQueue: Effect.Effect<MessageQueueSnapshot>
  // existing members unchanged
}
```

`OutboundMessage` (`src/host/session/protocol.ts`, re-exported to plugins by `src/host/plugin-api.ts`) gains `MessageQueueChanged { queued, held }` and `UserMessagesSent { messages }`. `plugin-api.ts` also exports the `OutgoingMessage` schema, because `plugins/claude-code/message-queue.ts` uses it as a value in its own schemas. `toIpcEvent` maps them to the two events above.

Attention (`src/shared/domain/attention.ts` has no `Completed->AwaitingPermission` and no `AwaitingPermission->Completed` transition):

| Path | Attention |
| --- | --- |
| `UserMessagesSent` | `toAttentionTarget` maps it to `Idle`, so a drained turn leaves `Completed` or `Errored` before its own permission request, completion or error |
| `PaneHandle.sendMessage` with `steer` | applies `Idle` before calling `session.sendText`, so a superseded card's `AwaitingPermission` ends and a card raised by the steer turn is not cleared afterwards. The aborted turn's `TurnCompleted` then moves `Idle` to `Completed`, and `UserMessagesSent` moves it back to `Idle` |
| `PaneHandle.sendMessage` with `queue` | applies nothing; a pending card's `AwaitingPermission` stays |

### Settings (`src/host/services/settings-store.ts`)

`settings.json` gains `sendMode: Schema.optional(SendMode)`. `getSendMode` returns `Option<SendMode>`, `None` when the field is absent, as `getTheme` does; the `GetSendMode` handler returns `DEFAULT_SEND_MODE` (`'queue'`) for `None`. `setSendMode` writes the field.

## Behaviour

### `MessageQueue` (pure, `plugins/claude-code/message-queue.ts`)

`QueueState` is a union of two `Schema.TaggedStruct` exports, and `QueueAction` of three; values are built with `.make`:

| Schema | Fields |
| --- | --- |
| `QueueIdle` | `queued`, `held` |
| `QueueRunning` | `queued`, `held`, `steered`, `dispatching` (count of `Dispatch` actions not yet offered) |
| `DispatchAction` | `messages` |
| `InterruptAction` | none |
| `QueueChangedAction` | `queued`, `held` |

`QueueChanged` below always carries the queue after the transition, with `held` false when `queued` is empty. Every transition that returns `Dispatch` also adds 1 to `dispatching`.

| Transition | From | To and actions |
| --- | --- | --- |
| `send(m, mode)` | `Idle` | `Running`, `queued` empty, `held` false, `steered` empty; `Dispatch(queued ++ [m])`; `QueueChanged` when `queued` was non-empty |
| `send(m, 'queue')` | `Running` | append `m` to `queued`, `held` false; `QueueChanged` |
| `send(m, 'steer')` | `Running`, `steered` empty | `steered = [m]`, `held` false; `Interrupt`; `QueueChanged` when `held` changed |
| `send(m, 'steer')` | `Running`, `steered` non-empty | append `m` to `steered`; no second `Interrupt` |
| `turnEnded(ok)` | `Running`, `steered` non-empty | `Running`, `steered` empty; `Dispatch(steered)` |
| `turnEnded(true)` | `Running`, `steered` empty, `held` false, `queued` non-empty | `Running`, `queued` empty; `Dispatch(queued)`; `QueueChanged` |
| `turnEnded(false)` | `Running`, `steered` empty, `queued` non-empty | `Idle`, `held` true; `QueueChanged` |
| `turnEnded(_)` | otherwise in `Running` | `Idle`; `queued` and `held` unchanged, so a held queue stays held |
| `turnEnded(_)` | `Idle` (a turn the CLI started) | no change |
| `stopRequested` | `Running` | `queued = steered ++ queued`, `steered` empty, `held` true when that is non-empty; `Interrupt`; `QueueChanged` when the queue or `held` changed |
| `stopRequested` | `Idle` (a turn the CLI started) | no change; `Interrupt` |
| `dispatchEnded` | `Running` | subtract 1 from `dispatching` |
| `dispatchEnded` | `Idle` | no change |
| `edit(id, t)` | `id` in `queued` | replace its text; `QueueChanged` |
| `remove(id)` | `id` in `queued` | remove it, and clear `held` when `queued` becomes empty; `QueueChanged` |
| `edit` / `remove` | `id` not in `queued` | no change; `QueueChanged`, so the renderer drops a stale item |
| `rewound` | any | `queued = steered ++ queued`, `held` true when that is non-empty; `Running` with empty `steered` when `dispatching > 0`, otherwise `Idle`; `QueueChanged` |
| `sessionEnded` | any | `Idle`, empty; `QueueChanged` |

`turnEnded(ok)` takes `true` for `TurnCompleted` (including an expected abort that `forward` turns into `TurnCompleted`) and `false` for a real `TurnErrored`. A held queue is dispatched with the next user send, ahead of it.

### Session wiring (`plugins/claude-code/session.ts`)

- The `QueueState` lives in one `Ref`. Every transition is a `Ref.modify` that returns its actions, so `forward` (the stream fiber) and the RPC calls change it without `restartLock`.
- `sendText` no longer holds `restartLock`; only the `dispatch` fiber and a steer's `Interrupt` take it. `sendText(text, mode)` creates the message with `id` = `${openedAtMillis}-${n}` (`Clock.currentTimeMillis` read when the session opens, and a per-session counter), runs `send`, performs the actions, and awaits the `dispatch` fiber (idle send) or the `Interrupt` (steer) before returning.
- `AgentSession.interrupt` runs `stopRequested` and performs its actions.
- **`dispatch(messages)`** runs in a fiber forked into the session scope that holds `restartLock`: `restartForThinkingChange`, `supersedePendingRequests`, emit `UserMessagesSent(messages)`, `offerBatch(messages)`; it runs `dispatchEnded` when it ends. When the session has ended (`endedDeferred` done) it skips the emit and the offer. Forking keeps `restartForThinkingChange` out of the stream fiber it interrupts. An idle send therefore returns after the offer, as today.
- **`offerBatch([m1 … mn])`** adds `n - 1` to `silentResults`, then offers `m1 … m(n-1)` with `shouldQuery: false` and `mn` as a normal `SDKUserMessage`. The counter is raised before any offer, because a silent result arrives about 1 ms after its message (`ct-sq.log`).
- **A steer's `Interrupt`** takes `restartLock`, re-reads `QueueState`, and runs `interruptSession` (supersedes pending cards, arms `abortExpectedRef`, calls `query.interrupt()`) only when the state is `Running` with `steered` non-empty; otherwise it logs a skip. Taking the lock makes the interrupt follow any pending `dispatch` offer. The re-read skips the interrupt when the turn ended while it waited (`turnEnded` already dispatched `steered`) or a rewind ended it (`rewound` emptied `steered`). A steer can wait behind a rewind for up to `REWIND_FILES_TIMEOUT`.
- **`stopRequested`'s `Interrupt`** runs `interruptSession` without the lock, as the stop button does today, so it works during a rewind.
- A `send(m, 'queue')` during a turn runs no restart and no supersede; the thinking level applies at the next `dispatch`.
- `forward` handles a turn end in this order: (1) a `TurnErrored` sets `silentResults = 0`; (2) a `TurnCompleted` while `silentResults > 0` is dropped and decrements `silentResults`, without touching `abortExpectedRef`; (3) the existing `abortExpectedRef` suppression; (4) `emit` the turn end; (5) `turnEnded` and its actions. `UserMessagesSent` therefore reaches the renderer after the turn end it follows.
- `rewindToCheckpoint`, after the fork opens, runs `rewound` and sets `silentResults = 0` and `abortExpectedRef` false. `restartForThinkingChange` sets `silentResults = 0` when it closes a query.
- `startQuery`'s `flatMap` that completes `endedDeferred` after `runSession` returns also runs `sessionEnded`.
- Each performed action is logged: `Effect.logInfo` for `Dispatch` and `Interrupt` with message ids, `Effect.logDebug` for `QueueChanged`.

**One turn from `[m1 … mn]`** relies on `SDKUserMessage.shouldQuery` (`sdk.d.ts` line 4455: "When false, the message is appended to the transcript without triggering an assistant turn"). Observed in SDK 0.3.207 with `combined-turn-repro.mjs`: three messages produced three replayed user messages, two `num_turns: 0` results and one assistant turn that answered from all three. Unverified: the order of silent results when an interrupt lands during a batch (step 1 of `forward` covers a batch cut short by an error), and whether `query.interrupt()` sent right after an offer aborts the turn that offer starts. The `interrupt` receipt documentation (`sdk.d.ts` near line 3403) says a batch "already dequeued for the imminent turn but not yet reachable by the abort" still runs; in that case the steer message runs after that turn. The app run for success criterion 5 checks this.

### Renderer

- `paneSendAtom` takes `{ text, mode }`, does not append the user turn, and calls `window.dia.sendMessage(paneId, text, mode)`.
- `PaneUserMessagesSent` appends one user turn per message, with id `${paneId}:user:${message.id}`, and sets `isLoading: true`. Messages 2 to n of a batch are marked `rewindable: false`: their `resumeAnchorUuid` is the assistant message before the batch, so a fork there would also drop message 1. `anchorCheckpoint` binds their uuids in order, as today, and the rewind control is hidden for them.
- `requestRewind`, `messagesBeforeRewind`, the kept-turn filter in `rewindToCheckpoint` (`pane-chat.ts`) and `nextUserMessageId` (`pane-chat-atoms.ts`) are removed: a message sent during a rewind now waits for `restartLock` and arrives as `PaneUserMessagesSent` after `PaneRewoundToCheckpoint`. `paneRewindAtom` no longer calls `requestRewind`.
- `PaneMessageQueueChanged` sets `PaneChatState.queued` and `PaneChatState.queueHeld`. `PaneAttentionChanged` with `Crashed` clears both. `loadHistory` in `paneChatAtom` sets both from `getMessageQueue`.
- The composer shows `queued` above the textarea: each item's text with an edit control (inline textarea; Enter saves, Escape cancels; save is disabled for blank text) and a remove control. A held queue shows the label `Sends with your next message`.
- `onKeyDown`: Enter without Shift sends in the default mode; Enter with `event.metaKey || event.ctrlKey` sends in the other mode. The slash-menu handling keeps precedence. The handler passes the mode through `form.handleSubmit({ mode })` (TanStack Form `onSubmitMeta`); the send button uses the default mode.
- `onSubmit` clears the pending permission, question and plan-review cards only when the mode is `steer` or no turn is running.
- `resend` sends `retryText` in the default mode. `interruptAndRetry` sends `retryText` with mode `steer`. Neither calls `interrupt()`. `paneInterruptAtom` is removed, because interrupt-and-retry was its only caller. `lastUserText` returns the last message of the last batch.
- `sendModeAtom` holds the default, read with `getSendMode` at startup and written with `setSendMode`. The command palette has a `Send mode` `ToggleGroup` row with `Queue` and `Steer` items under its `Theme` row, built the same way as the `Theme` row.

## Key Data Structures

- `SendMode` — `'queue' | 'steer'`.
- `OutgoingMessage` — `{ id, text }`. `id` is unique within the pane across session restarts, stable from creation until the message is sent, and used in the renderer turn id; `text` is the text the agent receives.
- `MessageQueueSnapshot` — `{ queued, held }`, as defined under Domain schemas.
- `QueueState` — internal to the adapter; listed under `MessageQueue`.
- `PaneChatState.queued: ReadonlyArray<OutgoingMessage>`, `PaneChatState.queueHeld: boolean` — the queue as last reported by the Host; empty and `false` in `emptyPaneChatState`.

## Internal Decomposition

- **`MessageQueue`** (`plugins/claude-code/message-queue.ts`) — the pure transitions over `QueueState`. No Effect services, no SDK types, no result accounting.
- **Session wiring** (`plugins/claude-code/session.ts`) — owns the `QueueState` `Ref` and `silentResults`, performs actions, and feeds turn ends from `forward`.
- **Kernel pass-through** — `PaneHandle`, `toIpcEvent`, `toAttentionTarget` and `rpc-handlers.ts`.
- **Renderer** — `pane-chat.ts` folds the two events; `pane.tsx` renders the queue and picks the mode; `sendModeAtom` and the command-palette entries.

## Design Rationale

**The adapter owns the queue.** User decision. The CLI's own queue coalesces messages into one user message joined with `\n` (observed with `combined-turn-repro.mjs`, plain variant) and cannot be listed or edited.

**`shouldQuery: false` for all but the last message.** User decision: one turn, each message kept as its own user message. Offering the messages without the flag starts a turn for the first and coalesces the rest.

**The renderer appends user turns only on `PaneUserMessagesSent`.** Only the adapter knows whether a message runs now, waits in the queue, or waits behind an interrupted turn. An optimistic append in the renderer would put a queued message in the transcript.

**Pure transitions, effectful wiring.** `MessageQueue` is tested as a table without the SDK. `silentResults` stays in the wiring because it counts SDK results, not user intent. `dispatching` is a `QueueRunning` field so `rewound` reads it in the same `Ref.modify` that changes the state.

**A user stop holds the queue.** Draining after the stop button would start a turn the user did not request. A failed turn holds the queue for the same reason: the user sees the error before more messages go out.

**Steer waits for the interrupted turn to end before offering.** An offer while the turn runs lets the CLI's own queue take the steer message, outside dia's ordering.

## Rejected Alternatives

**Renderer-owned queue** — rejected by the user.

**Offering queued messages without `shouldQuery: false`** — the CLI coalesces them into one user message (observed).

**`priority: 'next'` on the steer message** — declared without documented semantics (`sdk.d.ts` line 4448) and not tested.

## Tests

- `message-queue.test.ts`: every row of the `MessageQueue` table.
- Session tests against the fake `query()` of `session-rewind.test.ts`:
  - a batch is offered with `shouldQuery: false` on all but the last;
  - a silent result that arrives right after its offer is not emitted as `TurnCompleted`;
  - an expected abort after a silent result is still suppressed;
  - `UserMessagesSent` follows the turn end;
  - a queued send during a turn does not restart the query or supersede a card;
  - a steer during a pending `dispatch` interrupts after that offer;
  - a steer whose turn ended while its `Interrupt` waited for the lock does not interrupt the steer turn;
  - an idle send and a steer both return (no `restartLock` deadlock);
  - a `dispatch` after the session ended offers nothing;
  - a rewind during a pending idle `dispatch` leaves the state `Running`;
  - a rewind moves `steered` to the held queue;
  - a session end empties the queue.
- `rpc-handlers.test.ts`: payload fields reach the handler unchanged for each new command.
- `pane-supervisor` tests: `toIpcEvent` for the two new messages; `UserMessagesSent` moves `Completed` to `Idle`; a steer from `AwaitingPermission` ends in `Idle` with no rejected transition; a queued send leaves `AwaitingPermission`.
- `pane-chat.test.ts`: `PaneUserMessagesSent` then `PaneCheckpointAvailable` binds each uuid in order; `rewindable: false` on batch members 2 to n; `PaneMessageQueueChanged` and `Crashed`.
- Composer key handling: Enter uses the default mode, Cmd/Ctrl+Enter the other.
- Settings store: `getSendMode` is `'queue'` with no field.

## Documentation

- Every new module export has a JSDoc comment (root `CLAUDE.md`).
- New reasoning entry from `docs/reasoning/template.md`, `docs/reasoning/2026-10-25-should-query-false-batches-one-turn.md`, for the `shouldQuery: false` finding (evidence: `combined-turn-repro.mjs`, `ct-plain.log`, `ct-sq.log`), indexed in `docs/REASONING.md`.
- Update `docs/reasoning/2026-07-20-supersede-and-interrupt-turn-feedback.md`: a queued send no longer supersedes cards, and silent results are handled before the abort suppression.
- Update any reasoning entry that describes the renderer's optimistic user append.

## Not covered

Queue persistence across a Host restart; per-pane mode; queueing while idle.

## Refinement Record

### Round 1

**Applied**
- *Correctness* — a thinking restart during a turn in `queue` mode would end the turn and strand the queue: a queued send no longer restarts; `dispatch` runs the restart in a forked fiber.
- *Correctness* — `onSubmit` cleared pending cards in `queue` mode: cleared only in `steer` mode or when idle.
- *Correctness* — `interruptAndRetry` would queue and hold its retry text: it sends with `steer`.
- *Correctness* — `applyAttention(Idle)` after a queued send hid a pending card, and `Completed->AwaitingPermission` is invalid: `UserMessagesSent` maps to `Idle`; a queued send applies nothing.
- *Correctness* — a silent result consumed `abortExpectedRef`, and an aborted batch left `silentResults` set: fixed order in `forward`.
- *Correctness* — "only under `restartLock`" could not hold for `forward`: transitions are `Ref.modify`; `dispatch` takes the lock in a forked fiber.
- *Correctness* — edit and remove through `withLiveHandle` would start a dead pane: `withHandle`.
- *Correctness* — a rewind discarded `steered` and left `silentResults`: `steered` moves to the held queue; `silentResults` resets.
- *Correctness* — a history reload lost `queued`: `GetMessageQueue`, read by `loadHistory`.
- *Correctness* — `turnsInFlight` never decremented and a CLI-started turn was undefined: replaced by `Idle | Running`, with an `Idle` row.
- *Correctness* — a second steer interrupted twice: appends without a second `Interrupt`.
- *Correctness* — behaviour after a real `TurnErrored` was undefined: the queue is held.
- *Correctness* — a crash left a stale queue: `sessionEnded` transition; the renderer clears on `Crashed`.
- *Correctness* — edit or remove of a sent id left a stale item: emits the current queue.
- *Correctness* — rewinding batch members 2 to n drops message 1 in the fork: marked `rewindable: false`.
- *Correctness* — `requestRewind` and `messagesBeforeRewind` become dead code: removed.
- *Correctness* — per-session counter ids collide after a restart: the id adds the session's open time. `crypto.randomUUID()` is not used because the Effect diagnostics flag it, and the `effect/Crypto` service would need a new layer.
- *Project rules* — `GetSendMode`/`SetSendMode` use no `withRequestId`, as `GetTheme`/`SetTheme`; payload-field test added.
- *Project rules* — schemas moved to `src/shared/domain/message-queue.ts`.
- *Project rules* — Tests, Documentation and logging sections added; the `PROTOCOL_VERSION` consequence is stated; "Stop means stop" replaced with literal text.
- *Define Errors Out of Existence* — `turnsInFlight: number` allowed impossible counts and `steered` while idle: `Idle | Running` union.
- *Information Hiding* — `silentResults` moved out of `MessageQueue` into the wiring.
- *Principle of Least Astonishment* — the renderer could not tell a held queue: `held` in the event and state.
- *Names as Documentation* — `QueuedMessage` also named sent and steered messages: `OutgoingMessage`.
- *Single Abstraction Level* — `Interrupt` and `Supersede` merged into `Interrupt`.

**Rejected**
- *Project rules* — an ADR for the adapter-owned queue. Rejected: ADR-0029 already places the session's input queue in the adapter; this change follows it.
- *Project rules* — export `SendMode` and `OutgoingMessage` from `src/host/plugin-api.ts`. Rejected: the plugin imports them as types only, which resolve without the runtime alias; the new `OutboundMessage` members are already re-exported through `export * from './session/protocol'`. Revised during implementation: `message-queue.ts` uses `OutgoingMessage` as a schema value, so `plugin-api.ts` exports it.
- *Correctness* — `editQueuedText` with blank text removes the message. Rejected: the renderer disables save for blank text; removal has its own control.

### Round 2

**Applied**
- *Correctness* — `rewound` set `Idle` while a `dispatch` waited for `restartLock`, so a later idle send would go straight to the CLI queue: `rewound(dispatchPending)` keeps `Running`; the wiring counts `dispatchesPending`.
- *Correctness* — a steer during a pending card left attention at `AwaitingPermission` (`AwaitingPermission->Completed` is invalid): `sendMessage` with `steer` applies `Idle`.
- *Correctness* / *Avoid Temporal Decomposition* — `silentResults` was raised after the offers, racing the silent result: `offerBatch` raises it first.
- *Correctness* — a steer during a pending `dispatch` interrupted before the offer: a steer's `Interrupt` takes `restartLock`; the remaining window is listed as unverified and checked in the app run.
- *Correctness* — a rewind left `abortExpectedRef` armed: reset in `rewindToCheckpoint`.
- *Correctness* / *Names as Documentation* — `ended` had no hook and shared a name with `AgentSession.ended`: `sessionEnded`, run from `startQuery`'s `flatMap`; `interrupted` renamed `stopRequested`.
- *Define Errors Out of Existence* — `held` true with an empty queue: `held` is false whenever `queued` is empty.
- *Correctness* — the stop-button wiring was not stated: `AgentSession.interrupt` runs `stopRequested`.
- *Correctness* — a held queue did not drain after a steer, against the user decision: `send(m, 'steer')` clears `held`.
- *Correctness* — `priority: 'next'` is declared in `sdk.d.ts`: reworded to "declared without documented semantics".
- *Project rules* — hand-declared `{ _tag }` types: `Schema.TaggedStruct` exports built with `.make`.
- *Project rules* — `{ queued, held }` repeated in six places: `MessageQueueSnapshot`; arrays are `ReadonlyArray`.
- *Project rules* — reasoning entry path, template and index, and JSDoc on new exports, added to Documentation.
- *Project rules* — tests for the round 2 cases and composer key handling added.
- *Names as Documentation* — the `Send` action and `send` transition differed only by case: the action is `Dispatch`.
- *Single Abstraction Level* — the dispatch bullet mixed policy with SDK flag handling: `offerBatch` owns `shouldQuery` and `silentResults`.

**Rejected**
- *Project rules* — drive the session tests with `TestClock`. Rejected: no transition depends on time; the id's `Clock.currentTimeMillis` read already uses the test clock under `it.effect`.
- *Information Hiding* — a `SilentResultCounter` helper with `expect` and `consume`. Rejected: it would be a single-use abstraction over one `Ref`; `offerBatch` and steps 1 and 2 of `forward` are its only users.

### Round 3

**Applied**
- *Correctness* — a steer's `Interrupt` that waited for the lock could run against a fork after a rewind, or abort the steer turn after a natural turn end: it re-reads `QueueState` and runs only for `Running` with `steered` non-empty.
- *Correctness* — `sendText` kept `restartLock` while awaiting a fiber that takes it, a deadlock: `sendText` no longer holds the lock.
- *Correctness* — `Idle` applied after a steer's `sendText` could clear a card raised by the steer turn: `Idle` is applied before `sendText`, and the attention sequence is stated.
- *Correctness* — `stopRequested` had no `Idle` row and let a steered message run after a stop: `Idle` row added; a stop moves `steered` to the held queue. `remove` states that it clears `held`; the `turnEnded` fallback row states that a held queue stays held.
- *Avoid Temporal Decomposition* / *Information Hiding* — `dispatchesPending` was raised after the `Ref.modify` that set `Running`, and read in a separate step from `rewound`: `dispatching` is a `QueueRunning` field changed in the same `Ref.modify`; `rewound` takes no argument.
- *Correctness* — a `dispatch` fiber waiting for the lock at session end would offer into a closed query: it skips the emit and the offer when `endedDeferred` is done.
