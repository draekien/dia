---
status: "accepted"
date: 2026-10-25
decision-makers: William Pei
---

# Show a user turn in the transcript when the Host reports it sent, not when the composer submits it

## Context and Problem Statement

[ADR-0015](0015-effect-atom-and-direct-ipc-reducer-for-renderer-chat-state.md) point 3 has the renderer append the user message to the pane's chat atom when the composer submits it (`appendUserMessage`), then call `window.dia.sendMessage`. The message queue and steer (`docs/designs/message-queue-and-steer.md`) make a submitted message wait in the claude-code adapter while a turn runs, change while it waits (edit), or never reach the agent (remove). The adapter also sends every queued message as one turn when the running turn ends. An append at submit time therefore puts a message in the transcript that the agent may never receive, in the wrong order relative to the turn that was running. Where does the renderer learn that a user turn exists?

## Decision Drivers

* The transcript shows exactly the user messages the agent received, in the order it received them.
* A queued message is shown in the composer's queue, not the transcript, until it is sent.
* A message sent during a rewind lands after the truncated transcript without renderer bookkeeping.

## Considered Options

* Append when the Host reports the messages sent (`PaneUserMessagesSent`)
* Keep the append at submit time, and move or remove the turn when the queue changes

## Decision Outcome

Chosen option: "Append when the Host reports the messages sent", because the adapter is the only component that knows when a message reaches the SDK, and the report carries the final text and order.

`paneSendAtom` only calls `window.dia.sendMessage(paneId, text, mode)`. The reducer appends one user turn per message on `PaneUserMessagesSent`, with the id `${paneId}:user:${message.id}`, and sets `isLoading` true. `PaneMessageAppended{role:"user"}` stays ignored. The rest of ADR-0015 is unchanged.

### Consequences

* Good, because `requestRewind`, `messagesBeforeRewind` and the kept-turn filter in `rewindToCheckpoint` are removed: the adapter emits `PaneUserMessagesSent` for a message sent during a rewind after `PaneRewoundToCheckpoint`.
* Good, because an edited message appears with its edited text, and a removed message never appears.
* Bad, because an idle send appears after one round trip to the Host instead of at once.

## Pros and Cons of the Options

### Append when the Host reports the messages sent

* Good, because the transcript is derived from one event the adapter emits when it offers the batch to the SDK.
* Bad, because the renderer depends on the adapter emitting `UserMessagesSent`; an adapter that does not emit it shows no user turns.

### Keep the append at submit time

* Good, because an idle send appears without a round trip.
* Bad, because the reducer must remove or reorder turns on every queue edit, removal, batch send and rewind, duplicating the adapter's queue state.

## More Information

Amends ADR-0015 point 3. Implemented in `src/renderer/src/lib/pane-chat.ts` (`appendSentMessages`) and `plugins/claude-code/session.ts` (`dispatch`).
